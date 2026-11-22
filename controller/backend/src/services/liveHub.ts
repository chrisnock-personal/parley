// src/services/liveHub.ts
// Live updates pushed to clients and consoles (issue #12), instead of each
// of them polling. One loop reads pbx-core's status and the transcriber's
// who's-talking every TICK_MS for everybody, works out each subscriber's
// view, and sends it only when it has changed. Each user's database-backed
// details (their buttons, recording policy, settings, photos) are cached for
// USER_CTX_MS; the "new" markers' latest ids are one query a second across
// every subscribed user's groups. The loop runs only while someone is
// subscribed.
//
// The same payload builder serves the REST poll (GET
// /intercom-client/groups/participants), which clients fall back to when
// their stream drops, so the two can't drift apart.
import config from '../config';
import { avatarVersions, getDirectoryUser, listButtons, DirectoryUserButton } from './directoryUserService';
import { getSettings } from './settingsService';
import { latestIds } from './chatService';
import { talkersByDialCode } from './groupService';
import { getLiveStatus, LiveCall, LiveRegistration } from './pbxCoreService';

const TICK_MS = 500;
const USER_CTX_MS = 10_000;
const LATEST_MS = 1_000;

export interface Talking { group: string; extension: string }
export interface LiveSnapshot { registrations: LiveRegistration[]; calls: LiveCall[]; talking: Talking[] }

/** Who's talking right now, from the transcriber. Best-effort: down = nobody. */
export async function getTalking(): Promise<Talking[]> {
  try {
    const r = await fetch(`${config.transcriberUrl}/talking`, {
      signal: AbortSignal.timeout(500),
      headers: { Authorization: `Bearer ${config.internalToken}` },
    });
    return ((await r.json()) as { talking: Talking[] }).talking;
  } catch { return []; }
}

export async function getSnapshot(): Promise<LiveSnapshot> {
  const [status, talking] = await Promise.all([getLiveStatus(), getTalking()]);
  return { ...status, talking };
}

// ── The intercom client's view ──────────────────────────────────────────────

export interface UserCtx {
  userId: string;
  extension: string;
  buttons: DirectoryUserButton[];
  recordedByPolicy: boolean;
  talkers: Record<string, string[]>;
  avatars: Record<string, number>;
  loadedAt: number;
}

export async function loadUserCtx(userId: string, extension: string): Promise<UserCtx> {
  const buttons = await listButtons(userId);
  const [self, settings, avatars, talkers] = await Promise.all([
    getDirectoryUser(userId), getSettings(), avatarVersions(),
    talkersByDialCode(buttons.filter((b) => b.target_group_mode === 'announce' && b.target_group_dial_code)
      .map((b) => b.target_group_dial_code!)),
  ]);
  return {
    userId, extension, buttons, talkers, avatars, loadedAt: Date.now(),
    recordedByPolicy: self.siprec_enabled && !!settings.siprec_srs_uri,
  };
}

export const groupIdsOf = (ctx: UserCtx) => ctx.buttons
  .filter((b) => b.button_type === 'group' && b.target_group_id && b.target_group_dial_code);

/** Everything the client's 1 s view needs: who's in each of the user's
 * groups (talking, muted), who's online, recording state, listen-only
 * talkers and the newest chat/transcript ids for the "new" markers. */
export function buildClientPayload(ctx: UserCtx, live: LiveSnapshot,
  latestById: Record<string, { chat: string | null; transcript: string | null }>) {
  const mine = new Set(groupIdsOf(ctx).map((b) => b.target_group_dial_code!));
  const talking = new Set(live.talking.map((t) => `${t.group}/${t.extension}`));
  const participants: Record<string, { extension: string; name: string; talking: boolean; muted: boolean }[]> = {};
  const recordingGroups = new Set<string>();
  let icmRecording = false;
  for (const code of mine) participants[code] = [];
  for (const c of live.calls) {
    if (c.kind === 'group' && mine.has(c.to)) {
      participants[c.to].push({ extension: c.from, name: c.fromName, talking: talking.has(`${c.to}/${c.from}`), muted: !!c.muted });
      // Any member's recorded leg includes the group mix.
      if (c.recording) recordingGroups.add(c.to);
    }
    if (c.kind === 'direct' && c.recording && (c.from === ctx.extension || c.to === ctx.extension)) icmRecording = true;
  }
  const latest: Record<string, { chat: string | null; transcript: string | null }> = {};
  for (const b of groupIdsOf(ctx)) latest[b.target_group_dial_code!] = latestById[b.target_group_id!] ?? { chat: null, transcript: null };
  return {
    participants,
    latest,
    talkers: ctx.talkers,
    online: live.registrations.map((r) => r.extension),
    avatars: ctx.avatars,
    recording: { self: ctx.recordedByPolicy, icm: icmRecording, groups: [...recordingGroups] },
  };
}

// ── The hub ─────────────────────────────────────────────────────────────────

type Send = (json: string) => void;
interface ClientSub { kind: 'client'; userId: string; extension: string; send: Send; last?: string }
interface ConsoleSub { kind: 'console'; send: Send; last?: string }
type Sub = ClientSub | ConsoleSub;

const subs = new Set<Sub>();
const ctxCache = new Map<string, UserCtx>();
let latestCache: { at: number; byId: Record<string, { chat: string | null; transcript: string | null }> } = { at: 0, byId: {} };
let timer: NodeJS.Timeout | null = null;
let running = false;

function deliver(sub: Sub, payload: unknown) {
  const json = JSON.stringify(payload);
  if (json === sub.last) return;
  sub.last = json;
  try { sub.send(json); } catch { /* the connection is going away; its close handler unsubscribes */ }
}

async function tick() {
  if (running) return; // a slow pbx-core: skip rather than pile up
  running = true;
  try {
    let live: LiveSnapshot;
    try { live = await getSnapshot(); } catch { return; } // pbx-core down: keep everyone's last view
    for (const s of subs) if (s.kind === 'console') deliver(s, live);

    const clients = [...subs].filter((s): s is ClientSub => s.kind === 'client');
    if (!clients.length) return;
    for (const c of clients) {
      const cached = ctxCache.get(c.userId);
      if (!cached || Date.now() - cached.loadedAt > USER_CTX_MS) {
        try { ctxCache.set(c.userId, await loadUserCtx(c.userId, c.extension)); } catch { /* keep the old one */ }
      }
    }
    if (Date.now() - latestCache.at > LATEST_MS) {
      const ids = new Set<string>();
      for (const c of clients) for (const b of groupIdsOf(ctxCache.get(c.userId)!)) ids.add(b.target_group_id!);
      try { latestCache = { at: Date.now(), byId: await latestIds([...ids]) }; } catch { /* keep the old one */ }
    }
    for (const c of clients) {
      const ctx = ctxCache.get(c.userId);
      if (ctx) deliver(c, buildClientPayload(ctx, live, latestCache.byId));
    }
  } finally {
    running = false;
  }
}

function subscribe(sub: Sub): () => void {
  subs.add(sub);
  if (!timer) timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick(); // the first view straight away
  return () => {
    subs.delete(sub);
    if (sub.kind === 'client' && ![...subs].some((s) => s.kind === 'client' && s.userId === sub.userId)) ctxCache.delete(sub.userId);
    if (!subs.size && timer) { clearInterval(timer); timer = null; }
  };
}

export const subscribeClient = (userId: string, extension: string, send: Send) =>
  subscribe({ kind: 'client', userId, extension, send });
export const subscribeConsole = (send: Send) => subscribe({ kind: 'console', send });

/** A change the database-backed cache can't see by itself (a button given or
 * taken away, a talker marked): rebuild everyone's details on the next tick. */
export function invalidateUsers() { ctxCache.clear(); latestCache.at = 0; }

export function subscriberCount() { return subs.size; }
