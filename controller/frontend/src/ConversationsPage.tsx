// ConversationsPage.tsx -search and export what's still kept of groups'
// transcripts and chat (#27), and the AI shift summaries (#29). Editors and
// admins.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ConversationFilters, ConversationLine, DirectoryUser, Group, ShiftSummary } from './api';
import { Avatar } from './ui';

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function highlight(text: string, q: string) {
  if (!q.trim()) return text;
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.trim().length)}</mark>{text.slice(i + q.trim().length)}</>;
}

export default function ConversationsPage({ groups, users, onError }: { groups: Group[]; users: DirectoryUser[]; onError: (m: string) => void }) {
  const [group, setGroup] = useState('');
  const [person, setPerson] = useState('');
  const [from, setFrom] = useState(toLocalInput(startOfToday()));
  const [to, setTo] = useState('');
  const [words, setWords] = useState('');
  const [kind, setKind] = useState('');
  const [lines, setLines] = useState<ConversationLine[]>([]);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState<ConversationFilters | null>(null);
  const [summaries, setSummaries] = useState<ShiftSummary[]>([]);
  const [summariesOn, setSummariesOn] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshTimer = useRef<number | null>(null);

  const filters = (): ConversationFilters => ({
    group: group || undefined, person: person || undefined, q: words.trim() || undefined, kind: kind || undefined,
    from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to).toISOString() : undefined,
  });
  const loadSummaries = useCallback(async (f: ConversationFilters) => {
    try {
      const r = await api.listSummaries({ group: f.group, from: f.from, to: f.to });
      setSummaries(r.summaries); setSummariesOn(r.enabled);
    } catch (e) { onError((e as Error).message); }
  }, [onError]);

  const search = async () => {
    const f = filters();
    setBusy(true);
    try {
      const r = await api.searchConversations(f);
      setLines(r.lines); setTotal(r.total); setSearched(f);
      await loadSummaries(f);
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  const more = async () => {
    if (!searched) return;
    try { const r = await api.searchConversations(searched, lines.length); setLines((l) => [...l, ...r.lines]); }
    catch (e) { onError((e as Error).message); }
  };
  useEffect(() => { void search(); return () => { if (refreshTimer.current) window.clearInterval(refreshTimer.current); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const summariseNow = async () => {
    try {
      const r = await api.summariseNow(group || undefined);
      setNote(r.groups ? `Summarising ${r.groups === 1 ? 'the group' : `${r.groups} groups`} for ${r.shift} so far. They'll appear here as they're done.` : 'Nothing to summarise.');
      // Summaries take a little while each: refresh the list for two minutes.
      if (refreshTimer.current) window.clearInterval(refreshTimer.current);
      let n = 0;
      refreshTimer.current = window.setInterval(() => {
        void loadSummaries(searched ?? filters());
        if (++n >= 24 && refreshTimer.current) { window.clearInterval(refreshTimer.current); refreshTimer.current = null; }
      }, 5000);
    } catch (e) { onError((e as Error).message); }
  };

  const nameOf = (l: ConversationLine) => l.name ?? users.find((u) => u.extension === l.extension)?.name ?? l.extension;

  return (
    <div className="c-page">
      <div className="c-page-head"><h1>Conversations</h1><span className="c-mono">what was said and typed, while it's kept</span></div>
      <form className="c-card c-conv-filters" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="c-field small">Group<select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All groups</option>{groups.map((g) => <option key={g.id} value={g.dial_code}>{g.name}</option>)}</select></label>
        <label className="c-field small">Person<select value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Anyone</option>{users.map((u) => <option key={u.id} value={u.extension}>{u.name} ({u.extension})</option>)}</select></label>
        <label className="c-field small">From<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="c-field small">To<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="c-field small">Show<select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Said and typed</option><option value="said">Said</option><option value="typed">Typed</option></select></label>
        <label className="c-field small c-grow">Words<input value={words} onChange={(e) => setWords(e.target.value)} placeholder="anything said or typed" /></label>
        <button className="c-btn primary" type="submit" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>

      <div className="c-conv-grid">
        <section className="c-card">
          <div className="c-conv-head">
            <span className="c-grow c-help">{searched ? `${total} line${total === 1 ? '' : 's'}` : ''}</span>
            <button className="c-btn small" disabled={!total} onClick={() => searched && api.exportConversations(searched, 'text').catch((e) => onError(e.message))}>Export text</button>
            <button className="c-btn small" disabled={!total} onClick={() => searched && api.exportConversations(searched, 'csv').catch((e) => onError(e.message))}>Export CSV</button>
          </div>
          {lines.map((l) => (
            <div key={`${l.kind}${l.id}`} className="c-conv-line">
              <Avatar name={nameOf(l)} id={l.extension} size={24} />
              <div className="c-grow">
                <div className="c-conv-meta">{l.group_name} · {nameOf(l)} · {fmt(l.at)} · {l.kind}</div>
                <div>{highlight(l.text, searched?.q ?? '')}</div>
              </div>
            </div>
          ))}
          {!lines.length && <div className="c-empty">{searched ? 'Nothing matches.' : ''}</div>}
          {lines.length < total && <button className="c-btn small c-conv-more" onClick={() => void more()}>Show more ({total - lines.length} left)</button>}
        </section>

        <section className="c-card">
          <div className="c-conv-head">
            <span className="c-grow"><strong>Shift summaries</strong></span>
            <button className="c-btn small" disabled={!summariesOn} title={summariesOn ? undefined : 'Turn shift summaries on in Settings'}
              onClick={() => void summariseNow()}>Summarise now</button>
          </div>
          {note && <p className="c-help c-conv-note">{note}</p>}
          {!summariesOn && <p className="c-help c-conv-note">Shift summaries are off (Settings).</p>}
          {summaries.map((s) => (
            <div key={s.id} className="c-conv-summary">
              <div className="c-conv-sum-head">{s.group_name} · {new Date(s.shift_start).toLocaleDateString([], { dateStyle: 'medium' })} · {s.label}{s.partial ? ' · so far' : ''}</div>
              <div>{s.summary}</div>
              <div className="c-conv-meta">made {fmt(s.created_at)} from {s.line_count} line{s.line_count === 1 ? '' : 's'} · kept after the lines go</div>
            </div>
          ))}
          {summariesOn && !summaries.length && <div className="c-empty">No summaries for these dates yet.</div>}
        </section>
      </div>
    </div>
  );
}
