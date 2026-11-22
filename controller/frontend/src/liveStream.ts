// Copy of intercom-client/src/liveStream.ts (the two apps build separately).
// Reads a server-sent-events stream with fetch() (issue #12), so the
// Authorization header carries the token (EventSource can't send one).
// Calls onData with each `data:` JSON payload; resolves when the stream ends
// and rejects on a network or HTTP error, so the caller can fall back to
// polling and reconnect.
export async function readStream<T>(url: string, token: string, onData: (data: T) => void, signal: AbortSignal): Promise<void> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal });
  if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`);
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = event.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data) onData(JSON.parse(data) as T);
    }
  }
}
