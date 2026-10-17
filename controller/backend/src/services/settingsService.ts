// src/services/settingsService.ts -global key/value settings (system_settings,
// migration 013). Only known keys are readable/writable, each validated.
import { query } from '../db/pool';
import { createError } from '../middleware/errorHandler';

export interface Settings {
  siprec_srs_uri: string | null;      // global SIP-REC recording server; null = recording off
  transcript_retention_days: number;  // group transcript lines older than this are pruned hourly
}

const DEFAULTS: Settings = { siprec_srs_uri: null, transcript_retention_days: 30 };

export async function getSettings(): Promise<Settings> {
  const { rows } = await query<{ key: string; value: string | null }>(`SELECT key, value FROM system_settings`);
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const days = parseInt(raw.get('transcript_retention_days') ?? '', 10);
  return {
    siprec_srs_uri: raw.get('siprec_srs_uri')?.trim() || DEFAULTS.siprec_srs_uri,
    transcript_retention_days: Number.isFinite(days) ? days : DEFAULTS.transcript_retention_days,
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

  for (const [key, value] of writes) {
    await query(
      `INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
      [key, value, actor]);
  }
  return getSettings();
}
