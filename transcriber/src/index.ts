// Parley transcriber: taps every group member's own voice, for two
// things:
//  * who's talking right now, in every group (GET /talking on TALKING_PORT;
//    controller-backend merges it into the client's participant lists);
//  * live, per-speaker transcription of groups that have it switched on
//    (console: Groups -> Transcribe), stored so anyone with the group can
//    read it without joining (intercom client's transcript panel).
//
// Every POLL_MS it reads pbx-core's live call list. Each group call is one
// member's leg into the FreeSWITCH conference; it keeps a MemberTap
// (tap.ts) on each member's voice and drops it when the leg ends. Whether an
// utterance is transcribed is decided when it ends, from the current list of
// transcribed groups, so toggling Transcribe needs no re-tapping. Utterances
// go to the shared whisper-server one at a time (whisper.ts) and land in
// intercom_transcript_lines attributed to the speaker.
import { createServer } from 'http';
import { config } from './config';
import { MemberTap, Utterance } from './tap';
import { transcribe } from './whisper';
import { displayName, insertLine, transcribedGroups } from './db';

interface LiveCall { callId: string; kind: 'direct' | 'group'; from: string; to: string; callerTag: string; startedAt: number }

const taps = new Map<string, { tap: MemberTap; call: LiveCall }>();
const starting = new Set<string>();
// callId -> when a failed tap may be retried, so a leg we can't tap isn't
// re-subscribed (and logged) every poll.
const retryAfter = new Map<string, number>();
const RETRY_MS = 30_000;

// Same-room crosstalk: two members' mics in one room both hear whoever is
// talking (or a TV), so the same words arrive from two taps. A line that
// closely matches one from a DIFFERENT member of the same group spoken within
// CROSSTALK_MS is dropped -the first one to finish wins.
const CROSSTALK_MS = 8000;
const CROSSTALK_SIMILARITY = 0.6;
const recentLines = new Map<string, { extension: string; words: Set<string>; at: number }[]>();

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean));
}
function similarity(a: Set<string>, b: Set<string>): number {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / Math.max(1, a.size + b.size - both);
}
function isCrosstalk(group: string, extension: string, text: string, at: number): boolean {
  const w = words(text);
  const list = (recentLines.get(group) ?? []).filter((l) => Math.abs(at - l.at) < CROSSTALK_MS);
  const dup = list.some((l) => l.extension !== extension && similarity(w, l.words) >= CROSSTALK_SIMILARITY);
  if (!dup) list.push({ extension, words: w, at });
  recentLines.set(group, list.slice(-20));
  return dup;
}

async function handleUtterance(call: LiveCall, u: Utterance) {
  let groupId: string | undefined;
  try { groupId = (await transcribedGroups()).get(call.to); } catch { return; }
  if (!groupId) return; // this group isn't transcribed: the tap is only for who's-talking
  const text = await transcribe(u.pcm, { extension: call.from, group: call.to });
  if (!text) return;
  if (isCrosstalk(call.to, call.from, text, u.spokenAt.getTime())) {
    console.log(`[${call.to}] dropped as same-room crosstalk from ${call.from}: ${text}`);
    return;
  }
  try {
    const name = await displayName(call.from);
    await insertLine(groupId, call.from, name, text, u.spokenAt);
    console.log(`[${call.to}] ${name ?? call.from}: ${text}`);
  } catch (err) {
    console.error('[db] failed to store line:', (err as Error).message);
  }
}

async function tick() {
  let calls: LiveCall[];
  try {
    const res = await fetch(config.pbxStatusUrl, { signal: AbortSignal.timeout(3000) });
    calls = ((await res.json()) as { calls: LiveCall[] }).calls;
  } catch (err) {
    console.error('[poll] skipped:', (err as Error).message);
    return;
  }

  const wanted = new Map(calls.filter((c) => c.kind === 'group' && c.callerTag).map((c) => [c.callId, c]));

  for (const [callId, { tap }] of taps) {
    if (!wanted.has(callId)) { taps.delete(callId); void tap.stop(); }
  }
  for (const callId of retryAfter.keys()) if (!wanted.has(callId)) retryAfter.delete(callId);
  for (const [callId, call] of wanted) {
    if (taps.has(callId) || starting.has(callId)) continue;
    if ((retryAfter.get(callId) ?? 0) > Date.now()) continue;
    const tap = new MemberTap(callId, call.callerTag, (u) => void handleUtterance(call, u));
    starting.add(callId);
    tap.start()
      .then(() => {
        taps.set(callId, { tap, call });
        console.log(`[tap] ${call.from} in ${call.to}, ${Date.now() - call.startedAt} ms after the call started`);
        // Anything said before the first packet is lost to transcription.
        setTimeout(() => {
          if (tap.firstAudioAt) console.log(`[tap] ${call.from} in ${call.to}: first audio ${tap.firstAudioAt - call.startedAt} ms after the call started`);
        }, 5000);
      })
      .catch((err) => {
        console.error(`[tap] ${call.from} in ${call.to} failed (retrying in ${RETRY_MS / 1000}s): ${err.message}`);
        retryAfter.set(callId, Date.now() + RETRY_MS);
        void tap.stop();
      })
      .finally(() => starting.delete(callId));
  }
}

// GET /talking -> { talking: [{ group, extension }] }: who's speaking now.
// POST /poke -> 204: re-read pbx-core's call list now.
createServer((req, res) => {
  // POST /poke: pbx-core saying a member just joined a group -look now
  // rather than at the next poll, so their first words are tapped.
  if (req.method === 'POST' && req.url === '/poke') {
    void tick();
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/talking') {
    const talking = [...taps.values()]
      .filter(({ tap }) => tap.isTalking(config.talkHoldMs))
      .map(({ call }) => ({ group: call.to, extension: call.from }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ talking }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(config.talkingPort, () => console.log(`[startup] who's-talking on :${config.talkingPort}/talking`));

console.log(`[startup] transcriber polling ${config.pbxStatusUrl} every ${config.pollMs}ms, whisper at ${config.whisperUrl}`);
setInterval(() => void tick(), config.pollMs);
void tick();

async function shutdown() {
  await Promise.all([...taps.values()].map(({ tap }) => tap.stop()));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
