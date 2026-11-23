// Minimal in-memory registry of calls currently in progress. Same style as
// registrar.ts: no persistence, wiped for free on process restart (unlike
// FreeSWITCH's own conference-member state, this Map *is* pbx-core's state,
// so there's no stale-entry risk if pbx-core itself crashes/restarts).
// Read by the console's "Live" view, the intercom client (participants,
// recording indicators) and the transcriber -nothing here feeds SIP
// routing decisions.

export interface CallInfo {
  callId: string;
  kind: 'direct' | 'group';
  from: string;       // caller extension
  to: string;         // callee extension, or group dial code
  // rtpengine monologue tags of the two legs (caller = From tag; callee =
  // 'callee' for direct, 'fs' for group). The transcriber subscribes to a
  // group member's voice by callerTag; siprec.ts uses both.
  callerTag: string;
  calleeTag: string;
  startedAt: number;  // epoch ms
  // A SIP-REC session for this call is up right now (siprec.ts sets it once
  // the recording server has answered, and clears it if the recording
  // ends early). Drives the client's REC indicators, so it reflects what is
  // actually being recorded, not just policy.
  recording?: boolean;
  // Group calls: a listener in a listen-only group, whose media is blocked
  // for the whole call (issue #21); unmuting doesn't open it.
  listener?: boolean;
}

const calls = new Map<string, CallInfo>();

export function start(info: CallInfo): void {
  calls.set(info.callId, info);
}

export function setRecording(callId: string, recording: boolean): void {
  const c = calls.get(callId);
  if (c) c.recording = recording;
}

export function end(callId: string): void {
  calls.delete(callId);
}

export function all(): CallInfo[] {
  return [...calls.values()];
}
