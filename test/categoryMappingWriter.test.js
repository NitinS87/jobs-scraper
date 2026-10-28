const test = require('node:test');
const assert = require('node:assert');

/**
 * Local backfill 2026-10-28: Teal inserted 7,952 jobs, then one 500-row
 * job_category_mappings upsert hit a statement timeout and was dropped whole,
 * leaving those new jobs uncategorised with only errors=1 to show for it.
 */
function loadWriter(handler) {
  const calls = [];
  const clientPath = require.resolve('../lib/supabaseClient');
  require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true,
    exports: {
      from: (table) => ({
        upsert: (rows) => {
          calls.push(rows.length);
          return Promise.resolve(handler(table, rows));
        },
      }),
    },
  };
  delete require.cache[require.resolve('../lib/categoryMappingWriter')];
  return { writer: require('../lib/categoryMappingWriter'), calls };
}

const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
const plans = (n) => Array.from({ length: n }, (_, i) => ({ jobId: `j-${i}`, toInsert: ['c-1'], toDelete: [] }));

test('a statement timeout on a mapping batch is retried in halves, not discarded', async () => {
  const written = [];
  const { writer } = loadWriter((table, rows) => {
    if (rows.length > 125) return { error: TIMEOUT };
    written.push(...rows);
    return { error: null };
  });
  const stats = { errors: 0 };
  await writer.syncCategoryMappings(plans(500), stats);

  assert.equal(stats.errors, 0);
  assert.equal(written.length, 500, 'every mapping must land');
});

test('a non-timeout error is not bisected', async () => {
  const { writer, calls } = loadWriter(() => ({ error: { code: '42501', message: 'permission denied' } }));
  const stats = { errors: 0 };
  await writer.syncCategoryMappings(plans(500), stats);

  assert.deepEqual(calls, [500], 'a systemic error must cost one request, not one per row');
  assert.equal(stats.errors, 1);
});
