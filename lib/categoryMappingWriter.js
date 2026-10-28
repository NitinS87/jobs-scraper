/**
 * The single write path for job_category_mappings, shared by lib/uploader.js
 * and scripts/recategorise.js.
 *
 * Lifted out of the uploader rather than exported from it: requiring
 * lib/uploader.js from a script drags in logoUploader -> playwright and primes
 * module-level caches, and its export surface is deliberately narrow.
 */
const supabase = require('./supabaseClient');
const { chunk, isStatementTimeout } = require('./uploadPlanner');

const WRITE_CHUNK_SIZE = 500;
const MIN_WRITE_CHUNK_SIZE = 25;

/**
 * Upsert one slice, halving it on a statement timeout. A dropped slice leaves
 * freshly inserted jobs uncategorised for good unless a later run re-scrapes
 * them: one 500-row timeout did exactly that to Teal on 2026-10-28.
 */
async function upsertMappings(slice, stats) {
  // job_category_mappings has a composite PK on (job_id, category_id), so the
  // conflict target already exists — no DELETE needed to make this idempotent.
  const { error } = await supabase
    .from('job_category_mappings')
    .upsert(slice, { onConflict: 'job_id,category_id', ignoreDuplicates: true });

  if (!error) return;
  if (isStatementTimeout(error) && slice.length > MIN_WRITE_CHUNK_SIZE) {
    console.warn(`Batched category mapping insert hit a statement timeout at ${slice.length} rows — retrying in halves`);
    const half = Math.ceil(slice.length / 2);
    await upsertMappings(slice.slice(0, half), stats);
    await upsertMappings(slice.slice(half), stats);
    return;
  }
  console.warn(`Batched category mapping insert failed (${slice.length} rows): ${error.message}`);
  stats.errors += 1;
}

/**
 * When true, mappings are only ever added, never removed.
 *
 * The uploader reconciles categories for UNCHANGED jobs, so the first run after
 * a matcher change emits `toDelete` for every mapping the old rules produced
 * and the new ones do not — across 15,027 already-categorised jobs as measured
 * 2026-09-18. A bad rule silently deleting correct mappings is the only failure
 * mode here that cannot be walked back, so this gate exists to be switched on
 * for the first week after a matcher change.
 */
const additiveOnly = () => /^(1|true|yes|on)$/i.test(process.env.CATEGORY_ADDITIVE_ONLY || '');

/**
 * Insert new mappings and delete only the ones that were dropped.
 * @param {Array<{jobId: string, toInsert: string[], toDelete: string[]}>} plans
 * @param {{errors: number}} stats mutated in place
 */
async function syncCategoryMappings(plans, stats) {
  const inserts = [];
  for (const { jobId, toInsert } of plans) {
    for (const categoryId of toInsert) inserts.push({ job_id: jobId, category_id: categoryId });
  }

  for (const slice of chunk(inserts, WRITE_CHUNK_SIZE)) await upsertMappings(slice, stats);

  if (additiveOnly()) {
    const dropped = plans.reduce((n, p) => n + (p.toDelete ? p.toDelete.length : 0), 0);
    if (dropped > 0) {
      console.log(`CATEGORY_ADDITIVE_ONLY: kept ${dropped} mapping(s) the matcher no longer produces`);
    }
    return;
  }

  // Removals are rare (a job's resolved categories seldom shrink), so a
  // per-job delete here costs far less than the blanket delete-all it replaces.
  for (const { jobId, toDelete } of plans) {
    if (!toDelete || !toDelete.length) continue;
    const { error } = await supabase
      .from('job_category_mappings')
      .delete()
      .eq('job_id', jobId)
      .in('category_id', toDelete);

    if (error) console.warn(`Failed to remove stale category mappings: ${error.message}`);
  }
}

module.exports = { syncCategoryMappings, WRITE_CHUNK_SIZE };
