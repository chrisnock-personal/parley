import { useCallback, useEffect, useState } from 'react';
import { api, ArchiveTransfer, Settings } from './api';
import { Switch } from './ui';

// Global settings (admin-only), one card per area: the SIP-REC recording
// server; how long group transcripts and chat are kept (groups can override
// it, #26) and archiving them before they're deleted (#28); and AI shift
// summaries (#29), with optional names for the shifts.
const ZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone'); }
  catch { return ['UTC', 'Europe/Dublin', 'Europe/London']; }
})();

interface ShiftRow { time: string; name: string }

export default function SettingsPanel({ onError }: { onError: (msg: string) => void }) {
  const [srsUri, setSrsUri] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [archiveOn, setArchiveOn] = useState(false);
  const [transfer, setTransfer] = useState<ArchiveTransfer>({ type: 'local', path: 'transcripts' });
  const [summariesOn, setSummariesOn] = useState(false);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [timezone, setTimezone] = useState('UTC');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const apply = (s: Settings) => {
    setSrsUri(s.siprec_srs_uri ?? '');
    setRetentionDays(s.transcript_retention_days);
    setArchiveOn(s.archive_enabled);
    setTransfer(s.archive_transfer);
    setSummariesOn(s.summaries_enabled);
    setShifts(s.shift_starts.map((time) => ({ time, name: s.shift_names?.[time] ?? '' })));
    setTimezone(s.shift_timezone);
  };
  const load = useCallback(async () => {
    try { apply(await api.getSettings()); } catch (err) { onError((err as Error).message); }
  }, [onError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const rows = shifts.filter((r) => r.time);
      apply(await api.updateSettings({
        siprec_srs_uri: srsUri.trim() || null,
        transcript_retention_days: retentionDays,
        archive_enabled: archiveOn,
        archive_transfer: transfer,
        summaries_enabled: summariesOn,
        shift_starts: rows.map((r) => r.time),
        shift_names: Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.time, r.name.trim()])),
        shift_timezone: timezone.trim(),
      }));
      setMessage('Settings saved.');
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  }
  const setT = (patch: Partial<ArchiveTransfer>) => setTransfer((t) => ({ ...t, ...patch }));
  const setShift = (i: number, patch: Partial<ShiftRow>) => setShifts((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addShift = () => setShifts((l) => [...l, { time: '12:00', name: '' }]);

  return (
    <div className="c-settings">
      <section className="c-card c-set-card">
        <h2 className="c-set-h">Call recording (SIP-REC)</h2>
        <p className="c-help">
          Every call involving someone with "Record calls" on (People) is copied to this recording server as an
          RFC 7866 SIP-REC session. Leave it empty to turn recording off for everyone. If the server can't be
          reached, calls still go ahead, unrecorded.
        </p>
        <label className="c-field">Recording server URI
          <input value={srsUri} placeholder="sip:srs@10.0.0.5:5060" onChange={(e) => setSrsUri(e.target.value)} />
        </label>
      </section>

      <section className="c-card c-set-card">
        <h2 className="c-set-h">Transcripts and chat</h2>
        <p className="c-help">A working aid for catching up. The recording server keeps the official record.</p>
        <label className="c-field">Keep for, unless a group says otherwise
          <span className="c-set-row">
            <input className="c-mono-input" type="number" min={1} max={3650} value={retentionDays} style={{ width: 90 }}
              onChange={(e) => setRetentionDays(parseInt(e.target.value) || 1)} />
            <span className="c-set-unit">days</span>
          </span>
        </label>
        <Switch label="Archive before deleting" checked={archiveOn} onChange={setArchiveOn}
          help="Lines about to be deleted are first written to a dated file per group per day (JSONL). If the archive can't be written, nothing is deleted until it can. Groups set to don't keep aren't archived." />
        {archiveOn && (
          <div className="c-set-indent">
            <div className="c-seg" role="group" aria-label="Archive to">
              <button type="button" className={transfer.type === 'local' ? 'on' : ''} aria-pressed={transfer.type === 'local'} onClick={() => setT({ type: 'local' })}>This server</button>
              <button type="button" className={transfer.type === 'scp' ? 'on' : ''} aria-pressed={transfer.type === 'scp'} onClick={() => setT({ type: 'scp' })}>Another server (SCP)</button>
            </div>
            {transfer.type === 'local' ? (
              <label className="c-field">Folder
                <span className="c-set-row">
                  <span className="c-set-prefix">/var/lib/parley/archive/</span>
                  <input className="c-mono-input" value={transfer.path} placeholder="transcripts" onChange={(e) => setT({ path: e.target.value })} />
                </span>
              </label>
            ) : (
              <>
                <div className="c-set-grid">
                  <label className="c-field">Host<input value={transfer.host ?? ''} onChange={(e) => setT({ host: e.target.value })} /></label>
                  <label className="c-field">User<input value={transfer.user ?? ''} onChange={(e) => setT({ user: e.target.value })} /></label>
                  <label className="c-field">Port<input type="number" value={transfer.port ?? 22} onChange={(e) => setT({ port: parseInt(e.target.value) || 22 })} /></label>
                  <label className="c-field">Folder<input className="c-mono-input" value={transfer.path} placeholder="/srv/parley-archive" onChange={(e) => setT({ path: e.target.value })} /></label>
                </div>
                <label className="c-field">SSH key (a path inside the controller container)
                  <input className="c-mono-input" value={transfer.key_path ?? ''} onChange={(e) => setT({ key_path: e.target.value })} />
                </label>
                <HostKey onError={onError} />
              </>
            )}
          </div>
        )}
      </section>

      <section className="c-card c-set-card">
        <h2 className="c-set-h">Shift summaries</h2>
        <Switch label="Summarise each group's shift" checked={summariesOn} onChange={setSummariesOn}
          help="When a shift ends, groups that had something said or typed get a short AI summary (the server's own Ollama, nothing leaves it). Summaries are kept for 365 days, after the lines themselves are gone." />
        <div className="c-set-indent">
          <div className="c-field">Shifts start at
            <div className="c-chips">
              {shifts.map((r, i) => (
                <span key={i} className="c-shift">
                  <input type="time" value={r.time} aria-label="Start time" onChange={(e) => setShift(i, { time: e.target.value })} />
                  <input value={r.name} placeholder="Name" aria-label="Shift name" maxLength={30} onChange={(e) => setShift(i, { name: e.target.value })} />
                  {shifts.length > 1 && (
                    <button type="button" aria-label={`Remove ${r.time}`} onClick={() => setShifts((l) => l.filter((_, j) => j !== i))}>×</button>
                  )}
                </span>
              ))}
              {shifts.length < 12 && <button type="button" className="c-link" onClick={addShift}>+ Add a time</button>}
            </div>
            <span className="c-help">A name is optional: "Day" shows as Day (06:00–14:00).</span>
          </div>
          <label className="c-field">Time zone of those times
            <input value={timezone} list="parley-zones" onChange={(e) => setTimezone(e.target.value)} style={{ maxWidth: 280 }} />
            <datalist id="parley-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
          </label>
        </div>
      </section>

      <div className="c-set-save">
        <button className="c-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
        {message && <span className="c-set-saved">{message}</span>}
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
    <p className="c-help">
      <strong>{info.host}'s host key:</strong>{' '}
      {info.fingerprints.length
        ? <><code>{info.fingerprints.join(', ')}</code> pinned; a different key is refused.{' '}
            <button type="button" className="c-link" onClick={() => void forget()}>Forget it</button></>
        : 'not pinned yet. It\'s pinned the first time Parley sends an archive there.'}
    </p>
  );
}
