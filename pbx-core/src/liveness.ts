// Ends calls whose browser has gone (issue #15). A browser that crashes,
// sleeps or loses its network never sends BYE, and nothing else noticed: its
// leg stayed in the group (a ghost participant) until someone kicked it from
// the FreeSWITCH conference by hand.
//
// Media can't tell us: a listen-only member sends no audio at all, and a
// muted one may send little. So this asks the browser itself, at the SIP
// level: every LIVENESS_MS an OPTIONS request inside the call. Any answer,
// even an error status, means it's still there (JsSIP answers 200). It's
// gone when the request can't be delivered (503, or a send error: the
// WebSocket has closed), when the dialog is unknown there (481), or when
// MISSES_ALLOWED checks in a row get no answer within LIVENESS_TIMEOUT_MS.
import { config } from './config';

const GONE_STATUS = new Set([481, 503]);

/** Watches the given dialogs; calls onGone (once) when one of them has
 * gone. Returns a stop function for the call's own teardown. */
export function watchLegs(legs: { dlg: any; label: string }[], onGone: (label: string, why: string) => void): () => void {
  if (!legs.length || config.livenessMs <= 0) return () => {};
  let stopped = false;
  const misses = new Map<string, number>();

  const gone = (label: string, why: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    onGone(label, why);
  };

  const check = async ({ dlg, label }: { dlg: any; label: string }) => {
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res: any = await Promise.race([
        dlg.request({ method: 'OPTIONS' }),
        new Promise((resolve) => setTimeout(() => resolve(null), config.livenessTimeoutMs)),
      ]);
      status = res ? res.status : null;
    } catch (err: any) {
      error = err?.message || String(err);
    }
    if (stopped) return;
    if (error) return gone(label, `OPTIONS not sent: ${error}`);
    if (status !== null && GONE_STATUS.has(status)) return gone(label, `OPTIONS answered ${status}`);
    if (status === null) {
      const n = (misses.get(label) ?? 0) + 1;
      misses.set(label, n);
      if (n >= config.livenessMisses) gone(label, `no answer to ${n} OPTIONS in a row`);
      return;
    }
    misses.set(label, 0);
  };

  const timer = setInterval(() => { for (const leg of legs) void check(leg); }, config.livenessMs);
  return () => { stopped = true; clearInterval(timer); };
}
