// src/routes/admin.ts
// Database backup/restore/maintenance, admin-only. Ported from Walk the Nxt
// Floor's backend/src/routes/admin.ts, adapted for the one real
// architectural difference: WTNF runs backend+postgres in the same
// container (gosu postgres peer-auth over a local unix socket) -here
// postgres is a separate container reached over TCP, so pg_dump/psql are
// driven with -h/-p/-U + a PGPASSWORD env var instead.
import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { execFile, spawn } from 'child_process';
import * as zlib from 'zlib';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { requireAuth, requireRole } from '../middleware/session';
import { query } from '../db/pool';
import { audit } from '../services/auditService';
import config from '../config';
import { sendArchive } from '../services/archiveTransfer';
import { encryptFile } from '../services/encryption';
import { getSettings } from '../services/settingsService';

const router = Router();
const adminOnly = requireRole('admin');
router.use(requireAuth, adminOnly);

const execFileAsync = promisify(execFile);


function pgEnv(): NodeJS.ProcessEnv {
  // PGPASSWORD via env, never on the command line (would otherwise leak
  // into `ps`/process-listing output).
  return { ...process.env, PGPASSWORD: config.pgPassword };
}

// Arguments for execFile/spawn (no shell, #38).
function pgConnArgs(): string[] {
  return ['-h', config.pgHost, '-p', String(config.pgPort), '-U', config.pgUser, '-d', config.pgDatabase];
}

// ── Backup ──────────────────────────────────────────────────────────────────
router.post('/backup', async (req: Request, res: Response, next: NextFunction) => {
  const plain = path.join(os.tmpdir(), `parley-backup-${Date.now()}.sql`);
  let tmpFile = plain;
  try {
    await execFileAsync('pg_dump', [...pgConnArgs(), '-f', plain], { env: pgEnv(), timeout: 120_000 });
    // Encrypted to the backup key when one is set (#33): .sql.age.
    tmpFile = await encryptFile(plain, (await getSettings()).backup_recipient);
    const encrypted = tmpFile !== plain;
    const stat = fs.statSync(tmpFile);
    res.setHeader('Content-Type', encrypted ? 'application/octet-stream' : 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="parley-backup-${new Date().toISOString().slice(0,10)}.sql${encrypted ? '.age' : ''}"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', async () => {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
      await audit(req.user!.email, 'database', '00000000-0000-0000-0000-000000000000', 'update', { action: 'backup', encrypted });
    });
    stream.on('error', next);
  } catch (e) {
    for (const f of [plain, tmpFile]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
    next(e);
  }
});

// ── Restore ─────────────────────────────────────────────────────────────────
// Route-scoped raw-text body parser -deliberately not global, so every
// other route keeps using express.json() untouched. (WTNF's own comment on
// its equivalent route claims this wiring exists in its index.ts; it
// doesn't -this fixes that gap properly rather than repeating it.)
router.post('/restore', express.text({ type: '*/*', limit: '50mb' }),
  async (req: Request, res: Response, next: NextFunction) => {
    const tmpFile = path.join(os.tmpdir(), `parley-restore-${Date.now()}.sql`);
    try {
      if (typeof req.body === 'string' && req.body.startsWith('age-encryption.org')) {
        throw new Error('This backup is encrypted. Decrypt it with your backup key first (age -d -i key.txt file.sql.age > file.sql), then restore the .sql file');
      }
      if (typeof req.body !== 'string' || !req.body.startsWith('--')) {
        throw new Error('Invalid backup file -must be a PostgreSQL SQL dump');
      }
      fs.writeFileSync(tmpFile, req.body);
      await execFileAsync('psql', [...pgConnArgs(), '-f', tmpFile], { env: pgEnv(), timeout: 300_000 });
      await audit(req.user!.email, 'database', '00000000-0000-0000-0000-000000000000', 'update', { action: 'restore' });
      res.json({ ok: true, message: 'Restore completed' });
    } catch (e) {
      next(e);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    }
  });

// ── Backup info ───────────────────────────────────────────────────────────
router.get('/backup/info', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows: [size] } = await query<{ size: string }>(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size`
    );
    const { rows: [counts] } = await query(
      `SELECT
        (SELECT COUNT(*) FROM intercom_endpoints)       AS endpoints,
        (SELECT COUNT(*) FROM intercom_groups)          AS groups,
        (SELECT COUNT(*) FROM intercom_directory_users) AS directory_users,
        (SELECT COUNT(*) FROM intercom_sessions)        AS sessions,
        (SELECT COUNT(*) FROM audit_log)                AS audit_log`
    );
    res.json({ db_size: size.size, counts });
  } catch (e) { next(e); }
});

// ── Database maintenance ────────────────────────────────────────────────────
router.get('/db/stats', async (_req, res, next) => {
  try {
    const { rows: tables } = await query(
      `SELECT relname AS table,
              pg_size_pretty(pg_total_relation_size(relid)) AS size,
              pg_total_relation_size(relid) AS size_bytes,
              n_live_tup AS rows,
              n_dead_tup AS dead_rows,
              last_vacuum, last_autovacuum, last_analyze
       FROM pg_stat_user_tables
       ORDER BY pg_total_relation_size(relid) DESC`
    );
    const { rows: [dbSize] } = await query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
              pg_database_size(current_database()) AS size_bytes`
    );
    res.json({ tables, db_size: dbSize.size, db_size_bytes: dbSize.size_bytes });
  } catch (e) { next(e); }
});

router.post('/db/vacuum', async (req, res, next) => {
  try {
    await query('VACUUM ANALYZE');
    await audit(req.user!.email, 'database', '00000000-0000-0000-0000-000000000000', 'update', { action: 'vacuum' });
    res.json({ ok: true, message: 'VACUUM ANALYZE completed' });
  } catch (e) { next(e); }
});

// ── Purge (retention) ───────────────────────────────────────────────────────
// Whitelisted table names only -never interpolate an arbitrary client-
// supplied table name into SQL. intercom_endpoint_health_log already has
// its own automatic hourly prune (HEALTH_LOG_RETENTION_DAYS, see
// endpointHealthService.ts) and isn't offered here to avoid two retention
// mechanisms fighting over the same table.
const PURGEABLE_TABLES = ['audit_log', 'intercom_sessions', 'intercom_transcript_lines', 'intercom_chat_messages'] as const;
type PurgeableTable = typeof PURGEABLE_TABLES[number];

router.post('/db/purge', async (req, res, next) => {
  try {
    const { table, days = 90 } = req.body as { table?: string; days?: number };
    if (!table || !PURGEABLE_TABLES.includes(table as PurgeableTable)) {
      return res.status(400).json({ error: `table must be one of: ${PURGEABLE_TABLES.join(', ')}` });
    }
    if (days < 30) return res.status(400).json({ error: 'Minimum retention is 30 days' });

    const { rowCount } = table === 'audit_log'
      ? await query(`DELETE FROM audit_log WHERE event_time < now() - ($1 || ' days')::interval`, [days])
      : table === 'intercom_transcript_lines'
      ? await query(`DELETE FROM intercom_transcript_lines WHERE created_at < now() - ($1 || ' days')::interval`, [days])
      : table === 'intercom_chat_messages'
      ? await query(`DELETE FROM intercom_chat_messages WHERE created_at < now() - ($1 || ' days')::interval`, [days])
      // Never purge a live session, regardless of age.
      : await query(`DELETE FROM intercom_sessions WHERE state != 'active' AND started_at < now() - ($1 || ' days')::interval`, [days]);

    await audit(req.user!.email, 'database', '00000000-0000-0000-0000-000000000000', 'delete', { action: 'purge', table, days, deleted: rowCount ?? 0 });
    res.json({ ok: true, deleted: rowCount ?? 0, message: `Purged ${table} rows older than ${days} days` });
  } catch (e) { next(e); }
});

// ── Archive contents ────────────────────────────────────────────────────────
// pg_dump can't filter rows, so the archive is built from one
// COPY (SELECT ... older than N days) per table, written as a data-only SQL
// script in pg_dump's own COPY format: `psql -f` loads it back into the
// database the rows were purged from (they refer to its groups and people;
// rows still present there clash on their keys).
// days = 0 archives everything. Each WHERE takes the cutoff as an SQL
// expression: a bound parameter ($1) for the counts. COPY can't take
// parameters, so there it's cutoffLiteral(), which only ever renders an
// integer it has checked itself (#38).
const ARCHIVE_TABLES: { table: string; where: (cutoff: string) => string }[] = [
  { table: 'audit_log', where: (c) => `event_time < ${c}` },
  // Never a live session, as with purge.
  { table: 'intercom_sessions', where: (c) => `state != 'active' AND started_at < ${c}` },
  { table: 'intercom_session_participants', where: (c) =>
      `session_id IN (SELECT id FROM intercom_sessions WHERE state != 'active' AND started_at < ${c})` },
  { table: 'intercom_transcript_lines', where: (c) => `created_at < ${c}` },
  { table: 'intercom_chat_messages', where: (c) => `created_at < ${c}` },
];
const CUTOFF_PARAM = 'now() - make_interval(days => $1::int)';
function cutoffLiteral(days: number): string {
  if (!Number.isSafeInteger(days) || days < 0) throw new Error('days must be a non-negative integer');
  return `now() - make_interval(days => ${days})`;
}

// Streams one COPY ... TO STDOUT into `out`. spawn, no shell.
function copyOut(sql: string, out: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('psql', [...pgConnArgs(), '-X', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: pgEnv() });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.pipe(out, { end: false });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`psql exited ${code}: ${err.trim()}`)));
  });
}

async function writeArchive(file: string, days: number): Promise<Record<string, number>> {
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(file);
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gz.on('error', reject);
  });
  gz.pipe(out);
  const rows: Record<string, number> = {};
  try {
    gz.write(`-- Parley archive, ${new Date().toISOString()}\n`);
    gz.write(days === 0 ? '-- All rows.\n' : `-- Rows older than ${days} days.\n`);
    gz.write('-- Data only, in pg_dump COPY format. Load with psql -f into the Parley database these rows\n');
    gz.write('-- were purged from: sessions, transcripts and chat refer to its groups and people.\n\n');
    for (const { table, where } of ARCHIVE_TABLES) {
      const cols = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
      const list = cols.rows.map((c) => `"${c.column_name}"`).join(', ');
      const count = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where(CUTOFF_PARAM)}`, [days]);
      rows[table] = Number(count.rows[0].n);
      gz.write(`-- ${table}: ${rows[table]} rows\nCOPY public.${table} (${list}) FROM stdin;\n`);
      await copyOut(`COPY (SELECT ${list} FROM ${table} WHERE ${where(cutoffLiteral(days))}) TO STDOUT`, gz);
      gz.write('\\.\n\n');
    }
  } finally {
    gz.end();
  }
  await finished;
  return rows;
}

// ── Archive + remote transfer ───────────────────────────────────────────────
router.post('/db/archive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { days: rawDays = 90, transfer } = req.body as {
      days?: number;
      transfer?: { type: 'scp' | 'sftp' | 'ftp' | 'local'; host?: string; port?: number; user?: string; path: string; key_path?: string };
    };
    // days ends up in file names and in the archive's SQL -must be a bare
    // integer, not whatever a client JSON body actually sent.
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 0) {
      return res.status(400).json({ error: 'days must be a non-negative integer' });
    }
    const plainName = `parley-archive-${new Date().toISOString().slice(0,10)}-${days}d.sql.gz`;
    // One directory per request (#44): writeArchive()/encryptFile() have many
    // awaits and concurrent requests with the same `days` used to share one
    // deterministic path, so they could truncate, overwrite or unlink each
    // other's file. Only the delivered name stays deterministic.
    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'parley-archive-'));
    try {
      const plainFile = path.join(workDir, plainName);
      const rows = await writeArchive(plainFile, days);
      // Encrypted to the backup key when one is set (#33): .sql.gz.age.
      const tmpFile = await encryptFile(plainFile, (await getSettings()).backup_recipient);
      const archiveName = path.basename(tmpFile);
      const stat = fs.statSync(tmpFile);
      let transferResult = 'No transfer configured';

      if (transfer) transferResult = await sendArchive(tmpFile, archiveName, transfer);

      await audit(req.user!.email, 'database', '00000000-0000-0000-0000-000000000000', 'update', { action: 'archive', days, rows, transfer: transferResult });
      res.json({ ok: true, archive_name: archiveName, size_bytes: stat.size, rows, transfer: transferResult });
    } finally {
      // Scoped to this request: removes the encrypted file after transfer and
      // the plaintext too when no backup key was configured.
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch (e) { next(e); }
});

export default router;
