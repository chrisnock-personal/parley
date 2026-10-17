// Open Intercom transcriber: live, per-speaker transcription of groups that
// have it switched on (console: Groups -> Transcribe), stored so anyone with
// the group can read it without joining (intercom client's transcript panel).
//
// Every POLL_MS it reads pbx-core's live call list. Each group call is one
// member's leg into the FreeSWITCH conference; for those in a transcribed
// group it keeps a MemberTap (tap.ts) on the member's own voice, and drops
// it when the leg ends or transcription is switched off. Utterances go to
// the shared whisper-server one at a time (whisper.ts) and land in
// intercom_transcript_lines attributed to the speaker.
import { config } from './config';
import { MemberTap, Utterance } from './tap';
import { transcribe } from './whisper';
import { displayName, insertLine, transcribedGroups } from './db';

interface LiveCall { callId: string; kind: 'direct' | 'group'; from: string; to: string; callerTag: string }

const taps = new Map<string, MemberTap>();
const starting = new Set<string>();
// callId -> when a failed tap may be retried, so a leg we can't tap isn't
// re-subscribed (and logged) every poll.
const retryAfter = new Map<string, number>();
const RETRY_MS = 30_000;

async function handleUtterance(call: LiveCall, groupId: string, u: Utterance) {
  const text = await transcribe(u.pcm);
  if (!text) return;
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
  let groups: Map<string, string>;
  try {
    const res = await fetch(config.pbxStatusUrl, { signal: AbortSignal.timeout(3000) });
    calls = ((await res.json()) as { calls: LiveCall[] }).calls;
    groups = await transcribedGroups();
  } catch (err) {
    console.error('[poll] skipped:', (err as Error).message);
    return;
  }

  const wanted = new Map(calls.filter((c) => c.kind === 'group' && groups.has(c.to) && c.callerTag).map((c) => [c.callId, c]));

  for (const [callId, tap] of taps) {
    if (!wanted.has(callId)) { taps.delete(callId); void tap.stop(); }
  }
  for (const callId of retryAfter.keys()) if (!wanted.has(callId)) retryAfter.delete(callId);
  for (const [callId, call] of wanted) {
    if (taps.has(callId) || starting.has(callId)) continue;
    if ((retryAfter.get(callId) ?? 0) > Date.now()) continue;
    const groupId = groups.get(call.to)!;
    const tap = new MemberTap(callId, call.callerTag, (u) => void handleUtterance(call, groupId, u));
    starting.add(callId);
    tap.start()
      .then(() => { taps.set(callId, tap); console.log(`[tap] ${call.from} in ${call.to}`); })
      .catch((err) => {
        console.error(`[tap] ${call.from} in ${call.to} failed (retrying in ${RETRY_MS / 1000}s): ${err.message}`);
        retryAfter.set(callId, Date.now() + RETRY_MS);
        void tap.stop();
      })
      .finally(() => starting.delete(callId));
  }
}

console.log(`[startup] transcriber polling ${config.pbxStatusUrl} every ${config.pollMs}ms, whisper at ${config.whisperUrl}`);
setInterval(() => void tick(), config.pollMs);
void tick();

async function shutdown() {
  await Promise.all([...taps.values()].map((t) => t.stop()));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
