import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableSizes, type TableSizeQuery } from '../src/services/tableSizes';

function mockQuery(handle: (sql: string) => Record<string, unknown>[]): TableSizeQuery {
  return (async (sql: string) => ({ rows: handle(sql) })) as TableSizeQuery;
}

test('counts a known small table exactly even when the estimate is stale at 0', async () => {
  const sqls: string[] = [];
  const q = mockQuery((sql) => {
    sqls.push(sql);
    if (sql.includes('FROM pg_stat_user_tables')) return [
      { table: 'audit_log', size: '10 MB', rows: '1234' },
      { table: 'intercom_directory_users', size: '64 kB', rows: '0' },
    ];
    if (sql === 'SELECT COUNT(*)::bigint AS count FROM "intercom_directory_users"') return [{ count: '10' }];
    throw new Error(`Unexpected query: ${sql}`);
  });

  assert.deepEqual(await getTableSizes(q), [
    { table: 'audit_log', size: '10 MB', rows: 1234, rows_exact: false },
    { table: 'intercom_directory_users', size: '64 kB', rows: 10, rows_exact: true },
  ]);
  assert.equal(sqls.filter(sql => sql.includes('COUNT(*)')).length, 1, 'audit_log must not be counted exactly');
});

test('unknown tables keep a labelled estimate, including a NULL n_live_tup', async () => {
  const q = mockQuery((sql) => {
    if (sql.includes('FROM pg_stat_user_tables')) return [
      { table: 'some_new_table', size: '8 kB', rows: null },
    ];
    throw new Error(`Unexpected query: ${sql}`);
  });

  assert.deepEqual(await getTableSizes(q), [
    { table: 'some_new_table', size: '8 kB', rows: 0, rows_exact: false },
  ]);
});
