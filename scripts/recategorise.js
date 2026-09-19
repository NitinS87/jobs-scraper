/**
 * Re-run the category matcher over jobs that have no category mappings.
 *
 * Measured 2026-09-18: 17,228 of 32,255 jobs (53%) had zero mappings and 251 of
 * 392 categories were unused. Rows outside the recency window are never
 * re-scraped, so that backlog cannot heal itself — this script is the fix.
 *
 * Usage:
 *   node scripts/recategorise.js                  # DRY RUN (default) — writes nothing
 *   node scripts/recategorise.js --execute        # actually write mappings
 *   node scripts/recategorise.js --source Teal    # restrict to one source
 *   node scripts/recategorise.js --limit 500      # cap jobs processed
 *   node scripts/recategorise.js --all            # include already-categorised jobs
 *   node scripts/recategorise.js --after-id UUID  # resume from a keyset cursor
 *
 * Idempotent: mappings upsert on the composite PK with ignoreDuplicates, so a
 * second run writes nothing. Never touches the `jobs` table — no content_hash
 * churn, no is_active risk — and never selects `description` (8.9 KB/row).
 */
require('dotenv').config({ quiet: true });
const supabase = require('./../lib/supabaseClient');
const taxonomy = require('../lib/taxonomy.generated.json');
const { scoreTitle } = require('../lib/categoryScorer');
const { planCategorySync } = require('../lib/uploadPlanner');
const { syncCategoryMappings } = require('../lib/categoryMappingWriter');

const PAGE_SIZE = 1000;
const FLUSH_EVERY = 500;

function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    execute: has('--execute'),
    all: has('--all'),
    source: val('--source'),
    limit: Number(val('--limit')) || Infinity,
    afterId: val('--after-id') || '',
  };
}

/** Every existing mapping, as Map<jobId, Set<categoryId>>. ~19 requests. */
async function loadExistingMappings() {
  const byJob = new Map();
  let cursor = '';
  for (;;) {
    let q = supabase
      .from('job_category_mappings')
      .select('job_id, category_id')
      .order('job_id')
      .limit(PAGE_SIZE);
    if (cursor) q = q.gt('job_id', cursor);

    const { data, error } = await q;
    if (error) throw new Error(`Failed to read mappings: ${error.message}`);
    if (!data || !data.length) break;

    for (const row of data) {
      if (!byJob.has(row.job_id)) byJob.set(row.job_id, new Set());
      byJob.get(row.job_id).add(row.category_id);
    }
    const last = data[data.length - 1].job_id;
    if (last === cursor) break; // a job with >PAGE_SIZE categories cannot happen, but do not spin
    cursor = last;
    if (data.length < PAGE_SIZE) break;
  }
  return byJob;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.execute ? 'EXECUTE' : 'DRY RUN';
  console.log(`recategorise: ${mode}${args.source ? ` source=${args.source}` : ''}`
    + `${args.all ? ' (including already-categorised)' : ''}`);

  const existing = await loadExistingMappings();
  console.log(`Loaded ${existing.size} jobs with existing mappings`);

  const stats = {
    scanned: 0, considered: 0, matched: 0, unmatched: 0, errors: 0, wouldWrite: 0,
  };
  const byRoot = new Map();
  const unmatchedTitles = new Map();
  const samples = [];
  // Distinct normalised titles repeat heavily (9,036 distinct of 17,228), so
  // memoising roughly halves the scoring work.
  const memo = new Map();
  let plans = [];
  let cursor = args.afterId;

  const flush = async () => {
    if (!plans.length) return;
    if (args.execute) await syncCategoryMappings(plans, stats);
    plans = [];
  };

  for (;;) {
    let q = supabase
      .from('jobs')
      .select('id, title, external_source')
      .order('id')
      .limit(PAGE_SIZE);
    if (cursor) q = q.gt('id', cursor);
    if (args.source) q = q.eq('external_source', args.source);

    const { data, error } = await q;
    if (error) throw new Error(`Failed to read jobs: ${error.message}`);
    if (!data || !data.length) break;

    for (const job of data) {
      stats.scanned += 1;
      const prior = existing.get(job.id);
      if (!args.all && prior && prior.size) continue;
      if (stats.considered >= args.limit) break;
      stats.considered += 1;

      const key = String(job.title || '').trim().toLowerCase();
      if (!memo.has(key)) memo.set(key, scoreTitle(taxonomy, job.title));
      const hits = memo.get(key);

      if (!hits.length) {
        stats.unmatched += 1;
        unmatchedTitles.set(job.title, (unmatchedTitles.get(job.title) || 0) + 1);
        continue;
      }

      stats.matched += 1;
      const root = hits[0].root;
      byRoot.set(root, (byRoot.get(root) || 0) + 1);
      if (samples.length < 20) {
        samples.push(`  ${job.title.slice(0, 60).padEnd(60)} -> ${hits.map((h) => h.name).join(', ')}`);
      }

      const plan = planCategorySync(hits.map((h) => h.id), prior);
      if (plan.unchanged) continue;
      stats.wouldWrite += plan.toInsert.length;
      plans.push({ jobId: job.id, ...plan });
      if (plans.length >= FLUSH_EVERY) await flush();
    }

    cursor = data[data.length - 1].id;
    if (data.length < PAGE_SIZE || stats.considered >= args.limit) break;
  }

  await flush();

  const pct = stats.considered ? (100 * stats.matched / stats.considered).toFixed(1) : '0.0';
  console.log(`\nscanned=${stats.scanned} considered=${stats.considered} `
    + `matched=${stats.matched} (${pct}%) unmatched=${stats.unmatched} errors=${stats.errors}`);
  console.log(`${args.execute ? 'wrote' : 'would write'} ${stats.wouldWrite} mapping rows`);
  console.log(`last id processed: ${cursor} (resume with --after-id ${cursor})`);

  console.log('\nby root category:');
  for (const [root, n] of [...byRoot].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${root.padEnd(38)} ${n}`);
  }

  console.log('\nsample assignments:');
  samples.forEach((s) => console.log(s));

  console.log('\ntop 25 unmatched titles:');
  [...unmatchedTitles].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}x ${String(t).slice(0, 80)}`));

  if (!args.execute) console.log('\nDRY RUN — nothing was written. Re-run with --execute to apply.');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
