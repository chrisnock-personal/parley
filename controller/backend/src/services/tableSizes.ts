// src/services/tableSizes.ts
// Row counts for the Health page's "Table sizes". pg_stat_user_tables'
// n_live_tup is only a running estimate: it can read 0 (or stay stale) on a
// quiet table until ANALYZE runs, so count the small tables exactly. The few
// tables that can grow large keep the cheap estimate and are flagged as such
// so the UI can label them instead of presenting a guess as a fact.
import type { QueryResultRow } from 'pg';

export interface TableSizeRow {
  table: string;
  size: string;
  rows: number;
  rows_exact: boolean;
}

// Minimal shape of db/pool's query(), so this can be exercised with a mock.
export interface TableSizeQuery {
  <T extends QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// Only these known-small tables get COUNT(*). Anything else -audit_log,
// transcripts/chat, the endpoint health time series, and future tables -
// keeps the estimate and is marked rows_exact: false.
export const EXACT_COUNT_TABLES = new Set([
  'users',
  'intercom_endpoints',
  'intercom_groups',
  'intercom_group_members',
  'intercom_group_mutes',
  'intercom_directory_users',
  'intercom_directory_user_buttons',
  'intercom_sessions',
  'intercom_session_participants',
  'intercom_shift_summaries',
  'system_settings',
]);

export async function getTableSizes(q: TableSizeQuery): Promise<TableSizeRow[]> {
  const { rows: stats } = await q<{ table: string; size: string; rows: string | null }>(
    `SELECT relname AS table,
            pg_size_pretty(pg_total_relation_size(relid)) AS size,
            n_live_tup AS rows
     FROM pg_stat_user_tables
     ORDER BY pg_total_relation_size(relid) DESC
     LIMIT 5`
  );

  return Promise.all(stats.map(async ({ table, size, rows: estimate }) => {
    // n_live_tup is a bigint (returned as a string by node-postgres) and can
    // be null for a table that has never been analysed.
    const estimatedRows = Math.max(0, parseInt(estimate ?? '0', 10) || 0);
    if (!EXACT_COUNT_TABLES.has(table)) {
      return { table, size, rows: estimatedRows, rows_exact: false };
    }

    // table came from pg_stat_user_tables and must be in the whitelist above,
    // so no caller-supplied value is interpolated into this identifier.
    const { rows: [count] } = await q<{ count: string }>(
      `SELECT COUNT(*)::bigint AS count FROM "${table}"`
    );
    return { table, size, rows: parseInt(count.count, 10) || 0, rows_exact: true };
  }));
}
