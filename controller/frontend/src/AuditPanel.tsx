// AuditPanel.tsx -the audit log in plain language: when, who, what, and
// what it was about, filterable by time, person, kind of event and subject,
// 50 to a page, exportable as CSV.
import { useCallback, useEffect, useState } from 'react';
import { api, AuditLogEntry, Group } from './api';

const PAGE = 50;
const WHEN: Record<string, number | null> = { today: 0, '7d': 7, '30d': 30, all: null };

function fromFor(when: string): string | undefined {
  const days = WHEN[when];
  if (days === null || days === undefined) return undefined;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

const ACTION: Record<string, string> = {
  login: 'signed in', logout: 'signed out', create: 'created', update: 'changed', delete: 'deleted',
  call_start: 'call started', call_end: 'call ended', page: 'paged', ptt_grant: 'talk on', ptt_release: 'talk off',
  group_join: 'joined', group_leave: 'left',
};
const ACTION_CLASS: Record<string, string> = {
  call_start: 'call', call_end: 'call', page: 'call', group_join: 'call', group_leave: 'call',
  login: 'sign', logout: 'sign', delete: 'del',
};

const onOff = (v: unknown) => (v ? 'on' : 'off');
const FIELD_TEXT: Record<string, (v: unknown) => string> = {
  enabled: (v) => `log-in turned ${onOff(v)}`,
  siprec_enabled: (v) => `record calls turned ${onOff(v)}`,
  transcribe_enabled: (v) => `transcription turned ${onOff(v)}`,
  chat_enabled: (v) => `chat turned ${onOff(v)}`,
  ptt_default: (v) => `push to talk by default ${onOff(v)}`,
  mode: (v) => (v === 'announce' ? 'set to listen only' : 'set to talkback'),
  name: (v) => `name set to "${v}"`,
  extension: (v) => `extension set to ${v}`,
  dial_code: (v) => `dial code set to *8${v}`,
  siprec_srs_uri: (v) => (v ? `recording server set to ${v}` : 'recording server cleared'),
  transcript_retention_days: (v) => `transcripts and chat kept for ${v} days`,
  keep_days: (v) => (v === null ? 'transcripts and chat kept as Settings' : v === 0 ? "transcripts and chat not kept" : `transcripts and chat kept for ${v} days`),
  archive_enabled: (v) => `archive before deleting turned ${onOff(v)}`,
  archive_transfer: () => 'archive destination changed',
  summaries_enabled: (v) => `shift summaries turned ${onOff(v)}`,
  shift_names: () => 'shift names changed',
  tls_certificate: (v) => (v === 'local CA' ? "HTTPS certificate set back to Parley's own" : `HTTPS certificate uploaded: ${v}`),
  forgot_host_key: (v) => `pinned host key for ${v} forgotten`,
  shift_starts: (v) => `shifts start at ${Array.isArray(v) ? v.join(', ') : v}`,
  shift_timezone: (v) => `shift time zone set to ${v}`,
};

/** What happened, in words, from the entry's subject and metadata. */
export function describe(e: AuditLogEntry, groups: Group[]): string {
  const m = (e.metadata ?? {}) as Record<string, unknown>;
  const subject = e.entity_name ?? '';
  if (e.entity_type === 'session') {
    if (e.action === 'call_start') {
      const counterpart = String(m.counterpart ?? '');
      if (m.kind === 'group') return `Joined ${groups.find((g) => g.dial_code === counterpart)?.name ?? `*8${counterpart}`}`;
      return `Direct call ${m.direction === 'incoming' ? 'from' : 'to'} ${counterpart}`;
    }
    if (e.action === 'call_end') return m.reason ? `Ended (${m.reason})` : 'Ended';
  }
  if (e.entity_type === 'database') {
    const a = String(m.action ?? '');
    if (a === 'purge') return `Purged ${m.table} older than ${m.days} days (${m.deleted ?? 0} rows)`;
    if (a === 'archive') return `Archived rows older than ${m.days} days`;
    return a ? `Database ${a}` : 'Database';
  }
  if (e.entity_type === 'conversations') {
    if (e.action === 'export') return `Exported ${m.rows ?? 0} conversation lines (${m.format === 'csv' ? 'CSV' : 'text'})`;
    if (m.action === 'summarise') return `Summarise now: ${m.group === 'all' ? 'every group' : `*8${m.group}`}`;
  }
  if (e.action === 'login' || e.action === 'logout') return e.entity_type === 'user' ? 'Console' : 'Intercom client';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (FIELD_TEXT[k]) parts.push(FIELD_TEXT[k](v));
    else if (k === 'action' && v === 'reset-password') parts.push('password reset');
    else if (k === 'added_button') parts.push('a group or key added');
    else if (k === 'removed_button') parts.push('a group or key removed');
    else if (k === 'muted') parts.push(`${m.member ?? 'someone'} ${v ? 'muted' : 'unmuted'}`);
    else if (k === 'can_talk') parts.push(`${m.holder ?? 'someone'} ${v ? 'can talk' : 'listens only'}`);
    else if (k === 'avatar') parts.push(v === 'removed' ? 'photo removed' : 'photo changed');
  }
  const what = e.entity_type === 'settings' ? 'Settings' : e.entity_type === 'group' ? `Group ${subject}` : subject;
  return [what, parts.join(', ')].filter(Boolean).join(': ') || e.entity_type;
}

export default function AuditPanel({ groups, onError }: { groups: Group[]; onError: (msg: string) => void }) {
  const [when, setWhen] = useState('7d');
  const [who, setWho] = useState('');
  const [kind, setKind] = useState('');
  const [about, setAbout] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);

  const params = useCallback((o: number, limit = PAGE) => ({
    from: fromFor(when), actor: who.trim() || undefined, kind: kind || undefined, entity_type: about || undefined, limit, offset: o,
  }), [when, who, kind, about]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      api.getAuditLog(params(offset)).then((r) => { setRows(r.rows); setTotal(r.total); }).catch((e) => onError((e as Error).message));
    }, 250); // typing in Who shouldn't fire a request per key
    return () => window.clearTimeout(t);
  }, [params, offset, onError]);
  useEffect(() => { setOffset(0); }, [when, who, kind, about]);

  const who_ = (e: AuditLogEntry) => e.actor_name ? `${e.actor_name} (${e.actor})` : (e.actor ?? '');
  const exportCsv = async () => {
    try {
      const r = await api.getAuditLog(params(0, 500));
      const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
      const lines = [['When', 'Who', 'What', 'Details'].join(','),
        ...r.rows.map((e) => [new Date(e.event_time).toISOString(), who_(e), ACTION[e.action] ?? e.action, describe(e, groups)].map((x) => esc(String(x))).join(','))];
      const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `parley-audit-${new Date().toISOString().slice(0, 10)}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { onError((err as Error).message); }
  };

  return (
    <div className="c-page">
      <div className="c-page-head">
        <h1>Audit</h1>
        <button className="c-btn" onClick={exportCsv} title="Up to 500 rows matching the filters">Export CSV</button>
      </div>
      <div className="c-card c-filters">
        <label className="c-field small">When
          <select value={when} onChange={(e) => setWhen(e.target.value)}>
            <option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">Any time</option>
          </select>
        </label>
        <label className="c-field small">Who<input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name, extension or admin" /></label>
        <label className="c-field small">What
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Anything</option><option value="calls">Calls</option><option value="signins">Sign-ins</option><option value="changes">Changes</option><option value="deletions">Deletions</option>
          </select>
        </label>
        <label className="c-field small">About
          <select value={about} onChange={(e) => setAbout(e.target.value)}>
            <option value="">Anything</option><option value="directory_user">A person</option><option value="group">A group</option>
            <option value="session">A call</option><option value="settings">Settings</option><option value="database">The database</option><option value="user">A console user</option>
          </select>
        </label>
      </div>
      <div className="c-card c-list">
        <div className="c-row c-row-head audit-cols" aria-hidden="true"><span>When</span><span>Who</span><span>What</span><span>Details</span></div>
        <div className="c-list-body">
          {rows.map((e) => (
            <div key={e.id} className="c-row audit-cols static">
              <span className="c-mono" title={new Date(e.event_time).toLocaleString()}>{new Date(e.event_time).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span className="c-ellipsis">{e.actor_name ? <>{e.actor_name} <span className="c-mono">{e.actor}</span></> : e.actor}</span>
              <span><span className={`c-act ${ACTION_CLASS[e.action] ?? 'edit'}`}>{ACTION[e.action] ?? e.action}</span></span>
              <span className="c-ellipsis" title={describe(e, groups)}>{describe(e, groups)}</span>
            </div>
          ))}
          {!rows.length && <div className="c-empty">Nothing matches these filters.</div>}
        </div>
        <div className="c-pager">
          <span className="c-grow">{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '0 entries'}</span>
          <button className="c-btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
          <button className="c-btn small" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Older</button>
        </div>
      </div>
    </div>
  );
}
