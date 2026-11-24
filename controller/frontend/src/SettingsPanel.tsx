import { useCallback, useEffect, useState } from 'react';
import { api, ArchiveTransfer } from './api';

// Global settings (admin-only): the SIP-REC recording server, how long group
// transcripts and chat are kept (groups can override it, #26), archiving
// them before they're deleted (#28), and AI shift summaries (#29).
const ZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone'); }
  catch { return ['UTC', 'Europe/Dublin', 'Europe/London']; }
})();
const help = { fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 } as const;

export default function SettingsPanel({ onError }: { onError: (msg: string) => void }) {
  const [srsUri, setSrsUri] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [archiveOn, setArchiveOn] = useState(false);
  const [transfer, setTransfer] = useState<ArchiveTransfer>({ type: 'local', path: 'transcripts' });
  const [summariesOn, setSummariesOn] = useState(false);
  const [shiftStarts, setShiftStarts] = useState('06:00, 14:00, 22:00');
  const [timezone, setTimezone] = useState('UTC');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const apply = (s: Awaited<ReturnType<typeof api.getSettings>>) => {
    setSrsUri(s.siprec_srs_uri ?? '');
    setRetentionDays(s.transcript_retention_days);
    setArchiveOn(s.archive_enabled);
    setTransfer(s.archive_transfer);
    setSummariesOn(s.summaries_enabled);
    setShiftStarts(s.shift_starts.join(', '));
    setTimezone(s.shift_timezone);
  };
  const load = useCallback(async () => {
    try { apply(await api.getSettings()); } catch (err) { onError((err as Error).message); }
  }, [onError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMessage(null);
    try {
      apply(await api.updateSettings({
        siprec_srs_uri: srsUri.trim() || null,
        transcript_retention_days: retentionDays,
        archive_enabled: archiveOn,
        archive_transfer: transfer,
        summaries_enabled: summariesOn,
        shift_starts: shiftStarts.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
        shift_timezone: timezone.trim(),
      }));
      setMessage('Settings saved.');
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  }
  const setT = (patch: Partial<ArchiveTransfer>) => setTransfer((t) => ({ ...t, ...patch }));

  return (
    <div className="panel">
      <h2>Call recording (SIP-REC)</h2>
      <div style={help}>
        pbx-core sends a copy of every call involving a recorded user (People → "Record calls")
        to this recording server, as an RFC 7866 SIP-REC session. Leave empty to turn recording off
        for everyone. If the server can't be reached, calls still go ahead, unrecorded.
      </div>
      <div className="field">
        <label>Recording server URI</label>
        <input value={srsUri} placeholder="sip:srs@10.0.0.5:5060" onChange={e => setSrsUri(e.target.value)} />
      </div>

      <h2>Group transcripts and chat</h2>
      <div style={help}>
        A working aid for catching up; the recording server keeps the official record. Lines older
        than this are deleted (checked every 5 minutes). A group can keep its own way on its Groups page.
      </div>
      <div className="field">
        <label>Keep transcripts and chat for (days), unless a group says otherwise</label>
        <input type="number" min={1} max={3650} value={retentionDays}
          onChange={e => setRetentionDays(parseInt(e.target.value) || 1)} />
      </div>
      <label className="c-check" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={archiveOn} onChange={e => setArchiveOn(e.target.checked)} />
        Archive before deleting
      </label>
      <div style={help}>
        Lines about to be deleted are first written to a dated file per group per day (JSONL). If the
        archive can't be written, nothing is deleted until it can. Groups set to "don't keep" aren't archived.
      </div>
      {archiveOn && (
        <>
          <div className="field">
            <label>Archive to</label>
            <select value={transfer.type} onChange={e => setT({ type: e.target.value as ArchiveTransfer['type'] })}>
              <option value="local">This server (the archive volume)</option>
              <option value="scp">Another server, by SCP</option>
            </select>
          </div>
          <div className="field">
            <label>{transfer.type === 'local' ? 'Folder on the archive volume' : 'Folder on the remote server'}</label>
            <input value={transfer.path} onChange={e => setT({ path: e.target.value })} placeholder={transfer.type === 'local' ? 'transcripts' : '/srv/parley-archive'} />
          </div>
          {transfer.type === 'scp' && (
            <>
              <div className="field"><label>Host</label><input value={transfer.host ?? ''} onChange={e => setT({ host: e.target.value })} /></div>
              <div className="field"><label>User</label><input value={transfer.user ?? ''} onChange={e => setT({ user: e.target.value })} /></div>
              <div className="field"><label>Port</label><input type="number" value={transfer.port ?? 22} onChange={e => setT({ port: parseInt(e.target.value) || 22 })} /></div>
              <div className="field"><label>SSH key (path in the controller container)</label><input value={transfer.key_path ?? ''} onChange={e => setT({ key_path: e.target.value })} /></div>
              <HostKey onError={onError} />
            </>
          )}
        </>
      )}

      <h2>Shift summaries</h2>
      <div style={help}>
        When a shift ends, each group that had anything said or typed gets a short AI summary, made
        by this server's own Ollama (nothing leaves it). Summaries are kept for a year, after the lines
        themselves are gone, and shown in the client and on the Conversations page.
      </div>
      <label className="c-check" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={summariesOn} onChange={e => setSummariesOn(e.target.checked)} />
        Summarise each group's shift
      </label>
      <div className="field">
        <label>Shifts start at (24-hour times, separated by commas)</label>
        <input value={shiftStarts} onChange={e => setShiftStarts(e.target.value)} placeholder="06:00, 14:00, 22:00" />
      </div>
      <div className="field">
        <label>Time zone of those times</label>
        <input value={timezone} list="parley-zones" onChange={e => setTimezone(e.target.value)} />
        <datalist id="parley-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
        {message && <span style={{ fontSize: 12, color: 'var(--green)' }}>{message}</span>}
      </div>
    </div>
  );
}

// The SCP server's pinned host key (#30), for the saved settings.
function HostKey({ onError }: { onError: (msg: string) => void }) {
  const [info, setInfo] = useState<{ host: string | null; fingerprints: string[] } | null>(null);
  const load = useCallback(() => { api.archiveHostKey().then(setInfo).catch((e) => onError((e as Error).message)); }, [onError]);
  useEffect(() => { load(); }, [load]);
  if (!info?.host) return null;
  const forget = async () => {
    if (!window.confirm(`Forget ${info.host}'s host key? The next archive will trust and pin whatever key the server shows then.`)) return;
    try { await api.forgetArchiveHostKey(); load(); } catch (e) { onError((e as Error).message); }
  };
  return (
    <div style={help}>
      <strong>{info.host}'s host key:</strong>{' '}
      {info.fingerprints.length
        ? <><code>{info.fingerprints.join(', ')}</code> pinned; a different key is refused.{' '}<button type="button" onClick={() => void forget()}>Forget it</button></>
        : 'not pinned yet. It\'s pinned the first time Parley sends an archive there.'}
    </div>
  );
}
