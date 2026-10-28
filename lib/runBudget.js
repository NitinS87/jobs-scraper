/**
 * Soft whole-run budget for runScrapers.js.
 *
 * An explicit RUN_BUDGET_MS always wins. Without one, a cron run gets 50 min
 * (inside the 60-min CI hard cap) and a backfill runs unbounded.
 *
 * Kept out of runScrapers.js, which calls run() on require, so it can be tested.
 */
const CRON_DEFAULT_MS = 50 * 60 * 1000;

function resolveRunBudgetMs(env, backfillMode) {
  const explicit = Number(env.RUN_BUDGET_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return backfillMode ? Infinity : CRON_DEFAULT_MS;
}

module.exports = { resolveRunBudgetMs, CRON_DEFAULT_MS };
