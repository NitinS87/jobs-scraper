/**
 * Async shim over lib/categoryScorer.js. All matching logic lives in the
 * scorer, which is pure and unit-tested; this file only sources the taxonomy.
 *
 * Contract is unchanged from the previous keyword-map implementation:
 *   matchCategories(jobTitle, sourceCategories = []) -> Promise<string[]>
 * of LEAF job_categories.id values, deduped, possibly empty. No fallback
 * category — an empty array means "unclassified", which is deliberate.
 */
const supabase = require('./supabaseClient');
const snapshot = require('./taxonomy.generated.json');
const { matchCategoryIds, scoreTitle } = require('./categoryScorer');

const PAGE_SIZE = 1000;

let taxonomyPromise = null;
let warnedFallback = false;
let warnedDrift = false;

/** Reshape live rows into the committed snapshot's denormalised leaf form. */
function shapeFromRows(rows) {
  const byId = new Map(rows.map((c) => [c.id, c]));
  const parentIds = new Set(rows.filter((c) => c.parent_id).map((c) => c.parent_id));
  const leaves = [];

  for (const leaf of rows) {
    if (parentIds.has(leaf.id)) continue;
    const chain = [];
    for (let cur = leaf, hops = 0; cur; cur = cur.parent_id ? byId.get(cur.parent_id) : null) {
      chain.unshift(cur);
      if (++hops > 16) break;
    }
    const root = chain[0] || leaf;
    const group = chain.length >= 3 ? chain[chain.length - 2] : root;
    leaves.push({
      id: leaf.id,
      name: leaf.name,
      groupId: group.id,
      group: group.name,
      rootId: root.id,
      root: root.name,
    });
  }

  const roots = rows.filter((c) => !c.parent_id).map((c) => ({ id: c.id, name: c.name }));
  return { counts: { nodes: rows.length, roots: roots.length, leaves: leaves.length }, roots, leaves };
}

/**
 * Load the taxonomy once per process. Live-first, so a category added in
 * Supabase is matchable without a redeploy; falls back to the committed
 * snapshot on any error so a DB blip cannot take the pipeline down.
 */
async function loadCategories() {
  if (taxonomyPromise) return taxonomyPromise;

  taxonomyPromise = (async () => {
    try {
      const rows = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from('job_categories')
          .select('id, name, parent_id')
          .order('id')
          .range(from, from + PAGE_SIZE - 1);

        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < PAGE_SIZE) break;
      }

      if (rows.length < 300) throw new Error(`only ${rows.length} categories returned`);

      const live = shapeFromRows(rows);
      const drift = Math.abs(live.leaves.length - snapshot.counts.leaves) / snapshot.counts.leaves;
      if (drift > 0.05 && !warnedDrift) {
        warnedDrift = true;
        console.warn(
          `categoryMatcher: live taxonomy has ${live.leaves.length} leaves vs `
          + `${snapshot.counts.leaves} in the snapshot — run: node scripts/syncTaxonomy.js`,
        );
      }
      return live;
    } catch (err) {
      if (!warnedFallback) {
        warnedFallback = true;
        console.warn(`categoryMatcher: using committed taxonomy snapshot (${err.message})`);
      }
      return snapshot;
    }
  })();

  return taxonomyPromise;
}

/**
 * @returns {Promise<string[]>} leaf category ids; [] when nothing clears the
 * scorer's threshold.
 */
async function matchCategories(jobTitle, sourceCategories = []) {
  try {
    const taxonomy = await loadCategories();
    return matchCategoryIds(taxonomy, jobTitle, sourceCategories);
  } catch (err) {
    // uploader.js catches per job and skips the row entirely on a throw, so a
    // matcher fault would cost real jobs. Degrade to unclassified instead.
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(`categoryMatcher: matching failed, returning no categories (${err.message})`);
    }
    return [];
  }
}

/** Debug-rich variant used by scripts/recategorise.js --dry-run reporting. */
async function explainCategories(jobTitle, sourceCategories = []) {
  const taxonomy = await loadCategories();
  return scoreTitle(taxonomy, jobTitle, sourceCategories);
}

module.exports = { matchCategories, loadCategories, explainCategories };
