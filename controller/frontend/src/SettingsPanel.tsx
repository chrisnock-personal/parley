import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// Global settings (admin-only): the SIP-REC recording server that pbx-core
// sends recorded calls to, and how long group transcripts are kept. Which
// users are recorded is set per user (Directory Users); which groups are
// transcribed, per group (Groups).
export default function SettingsPanel({ onError }: { onError: (msg: string) => void }) {
  const [srsUri, setSrsUri] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSrsUri(s.siprec_srs_uri ?? '');
      setRetentionDays(s.transcript_retention_days);
    } catch (err) { onError((err as Error).message); }
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const s = await api.updateSettings({ siprec_srs_uri: srsUri.trim() || null, transcript_retention_days: retentionDays });
      setSrsUri(s.siprec_srs_uri ?? '');
      setRetentionDays(s.transcript_retention_days);
      setMessage('Settings saved.');
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h2>Call recording (SIP-REC)</h2>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
        pbx-core sends a copy of every call involving a recorded user (Directory Users → "Record calls")
        to this recording server, as an RFC 7866 SIP-REC session. Leave empty to turn recording off
        for everyone. If the server can't be reached, calls still go ahead, unrecorded.
      </div>
      <div className="field">
        <label>Recording server URI</label>
        <input value={srsUri} placeholder="sip:srs@10.0.0.5:5060" onChange={e => setSrsUri(e.target.value)} />
      </div>

      <h2>Group transcripts</h2>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
        Groups with "Transcribe" on (Groups page) are transcribed live per speaker. Lines older than
        this are deleted automatically, hourly.
      </div>
      <div className="field">
        <label>Keep transcripts for (days)</label>
        <input type="number" min={1} max={3650} value={retentionDays}
          onChange={e => setRetentionDays(parseInt(e.target.value) || 1)} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
        {message && <span style={{ fontSize: 12, color: 'var(--green)' }}>{message}</span>}
      </div>
    </div>
  );
}
