// Remote mutes (issue #9): people the console has muted in a group. Kept by
// group and extension, not by call, so leaving and rejoining doesn't unmute
// anyone: groups.ts reapplies a mute when a muted member joins. In memory,
// like the rest of pbx-core's state, so a pbx-core restart clears them.
export interface Mute { by: string; at: number }

const mutes = new Map<string, Mute>();
const key = (group: string, ext: string) => `${group}/${ext}`;

export function set(group: string, ext: string, by: string): void { mutes.set(key(group, ext), { by, at: Date.now() }); }
export function clear(group: string, ext: string): void { mutes.delete(key(group, ext)); }
export function get(group: string, ext: string): Mute | undefined { return mutes.get(key(group, ext)); }
