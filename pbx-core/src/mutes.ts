// Remote mutes (issue #9): people the console has muted in a group. Kept by
// group and extension, not by call, so leaving and rejoining doesn't unmute
// anyone: groups.ts reapplies a mute when a muted member joins. The database
// (intercom_group_mutes, written by controller-backend) is the record: this
// copy is loaded at start and every SYNC_MS, so a restart no longer unmutes
// anyone (issue #19), and set()/clear() keep it current in between.
import { loadMutes } from './db';

export interface Mute { by: string; at: number }

const mutes = new Map<string, Mute>();
const key = (group: string, ext: string) => `${group}/${ext}`;

export function set(group: string, ext: string, by: string): void { mutes.set(key(group, ext), { by, at: Date.now() }); }
export function clear(group: string, ext: string): void { mutes.delete(key(group, ext)); }
export function get(group: string, ext: string): Mute | undefined { return mutes.get(key(group, ext)); }

const SYNC_MS = 60_000;

async function sync() {
  try {
    const rows = await loadMutes();
    mutes.clear();
    for (const r of rows) mutes.set(key(r.group, r.extension), { by: r.by, at: r.at });
  } catch (err: any) {
    console.error('[mute] loading mutes from the database failed:', err?.message || err);
  }
}

/** Load the saved mutes now and keep them in step. */
export function startMuteSync(): void {
  void sync();
  setInterval(() => { void sync(); }, SYNC_MS);
}
