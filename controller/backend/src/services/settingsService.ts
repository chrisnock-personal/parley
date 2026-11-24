// src/services/settingsService.ts -global key/value settings (system_settings,
// migration 013). Only known keys are readable/writable, each validated.
import { query } from '../db/pool';
import { createError } from '../middleware/errorHandler';

/** Where archived transcript/chat files go (#28): the same choices as the
 * Backups archive. */
export interface ArchiveTransfer {
  type: 'local' | 'scp';
  path: string;          // local: a folder under the archive volume; scp: the remote folder
  host?: string; user?: string; port?: number; key_path?: string;
}

export interface Settings {
  siprec_srs_uri: string | null;      // global SIP-REC recording server; null = recording off
  transcript_retention_days: number;  // default for groups without their own keep_days (#26)
  archive_enabled: boolean;           // write lines to dated files before deleting them (#28)
  archive_transfer: ArchiveTransfer;
  summaries_enabled: boolean;         // AI summary per group per shift (#29)
  shift_starts: string[];             // "HH:MM", sorted
  shift_timezone: string;             // IANA zone the shift times are in
}

const DEFAULTS: Settings = {
  siprec_srs_uri: null, transcript_retention_days: 30,
  archive_enabled: false, archive_transfer: { type: 'local', path: 'transcripts' },
  summaries_enabled: false, shift_starts: ['06:00', '14:00', '22:00'], shift_timezone: 'UTC',
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseTransfer(raw: string | null | undefined): ArchiveTransfer {
  try {
    const t = JSON.parse(raw ?? '') as ArchiveTransfer;
    if (t && (t.type === 'local' || t.type === 'scp') && typeof t.path === 'string') return t;
  } catch { /* default */ }
  return DEFAULTS.archive_transfer;
}

export async function getSettings(): Promise<Settings> {
  const { rows } = await query<{ key: string; value: string | null }>(`SELECT key, value FROM system_settings`);
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const days = parseInt(raw.get('transcript_retention_days') ?? '', 10);
  const starts = (raw.get('shift_starts') ?? '').split(',').map((s) => s.trim()).filter((s) => HHMM.test(s));
  return {
    siprec_srs_uri: raw.get('siprec_srs_uri')?.trim() || DEFAULTS.siprec_srs_uri,
    transcript_retention_days: Number.isFinite(days) ? days : DEFAULTS.transcript_retention_days,
    archive_enabled: raw.get('archive_enabled') === 'true',
    archive_transfer: parseTransfer(raw.get('archive_transfer')),
    summaries_enabled: raw.get('summaries_enabled') === 'true',
    shift_starts: starts.length ? [...new Set(starts)].sort() : DEFAULTS.shift_starts,
    shift_timezone: raw.get('shift_timezone')?.trim() || DEFAULTS.shift_timezone,
  };
}

export async function updateSettings(actor: string, fields: Partial<Settings>): Promise<Settings> {
  const writes: [keyof Settings, string | null][] = [];

  if (fields.siprec_srs_uri !== undefined) {
    const uri = fields.siprec_srs_uri?.trim() || null;
    // pbx-core hands this straight to drachtio as a request URI.
    if (uri && !/^sips?:[^\s<>]+$/i.test(uri)) {
      throw createError('siprec_srs_uri must be a SIP URI, e.g. sip:srs@10.0.0.5:5060', 400);
    }
    writes.push(['siprec_srs_uri', uri]);
  }
  if (fields.transcript_retention_days !== undefined) {
    const days = Number(fields.transcript_retention_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw createError('transcript_retention_days must be a whole number of days (1-3650)', 400);
    }
    writes.push(['transcript_retention_days', String(days)]);
  }
  if (fields.archive_enabled !== undefined) {
    if (typeof fields.archive_enabled !== 'boolean') throw createError('archive_enabled must be true or false', 400);
    writes.push(['archive_enabled', String(fields.archive_enabled)]);
  }
  if (fields.archive_transfer !== undefined) {
    const t = fields.archive_transfer;
    if (!t || (t.type !== 'local' && t.type !== 'scp') || typeof t.path !== 'string' || !t.path.trim()) {
      throw createError('archive_transfer needs type (local or scp) and path', 400);
    }
    if (t.type === 'scp' && (!t.host || !t.user)) throw createError('An SCP archive needs host and user', 400);
    const port = t.port === undefined ? undefined : Number(t.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw createError('port must be 1-65535', 400);
    writes.push(['archive_transfer', JSON.stringify({
      type: t.type, path: t.path.trim(),
      ...(t.type === 'scp' ? { host: t.host, user: t.user, port, key_path: t.key_path || undefined } : {}),
    })]);
  }
  if (fields.summaries_enabled !== undefined) {
    if (typeof fields.summaries_enabled !== 'boolean') throw createError('summaries_enabled must be true or false', 400);
    writes.push(['summaries_enabled', String(fields.summaries_enabled)]);
  }
  if (fields.shift_starts !== undefined) {
    const s = fields.shift_starts;
    if (!Array.isArray(s) || !s.length || s.length > 12 || !s.every((x) => typeof x === 'string' && HHMM.test(x))) {
      throw createError('shift_starts must be 1-12 times like 06:00', 400);
    }
    writes.push(['shift_starts', [...new Set(s)].sort().join(',')]);
  }
  if (fields.shift_timezone !== undefined) {
    const tz = String(fields.shift_timezone).trim();
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw createError(`Unknown time zone: ${tz}`, 400); }
    writes.push(['shift_timezone', tz]);
  }

  for (const [key, value] of writes) {
    await query(
      `INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
      [key, value, actor]);
  }
  return getSettings();
}
