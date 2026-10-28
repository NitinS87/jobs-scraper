const test = require('node:test');
const assert = require('node:assert');

const { resolveRunBudgetMs } = require('../lib/runBudget');

test('cron runs default to the 50-minute budget', () => {
  assert.equal(resolveRunBudgetMs({}, false), 50 * 60 * 1000);
});

test('cron runs honour an explicit RUN_BUDGET_MS', () => {
  assert.equal(resolveRunBudgetMs({ RUN_BUDGET_MS: '600000' }, false), 600000);
});

test('a backfill with no explicit budget is unlimited', () => {
  assert.equal(resolveRunBudgetMs({}, true), Infinity);
});

test('a backfill honours an explicit RUN_BUDGET_MS', () => {
  // backfill-jobs.yml passes run_budget_ms (default 5h) so the run can exit
  // with a summary before GitHub's 330-minute job timeout SIGKILLs it.
  // BACKFILL_MODE used to force Infinity and silently drop that input; a local
  // outage backfill on 2026-10-28 logged "Infinity min budget left" despite
  // RUN_BUDGET_MS=7200000.
  assert.equal(resolveRunBudgetMs({ RUN_BUDGET_MS: '7200000' }, true), 7200000);
});

test('a blank or non-numeric RUN_BUDGET_MS falls back to the mode default', () => {
  // An empty workflow input arrives as ''.
  assert.equal(resolveRunBudgetMs({ RUN_BUDGET_MS: '' }, true), Infinity);
  assert.equal(resolveRunBudgetMs({ RUN_BUDGET_MS: 'abc' }, false), 50 * 60 * 1000);
  assert.equal(resolveRunBudgetMs({ RUN_BUDGET_MS: '0' }, false), 50 * 60 * 1000);
});
