/**
 * Regenerate lib/taxonomy.generated.json from the live job_categories table.
 *
 * Usage: node scripts/syncTaxonomy.js [--check]
 *
 *   --check  exit 1 if the committed file differs from the live DB (for CI),
 *            without writing anything.
 *
 * The categoriser reads the committed JSON rather than querying per process, so
 * it stays pure and unit-testable (same reason lib/uploadPlanner.js exists).
 * Re-run this whenever categories are added or renamed in Supabase.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabaseClient');

const OUT_PATH = path.join(__dirname, '..', 'lib', 'taxonomy.generated.json');
const PAGE_SIZE = 1000;

// The old loadCategories() issued one unpaginated select, which PostgREST caps
// (default 1000 rows). That is fine at 392 nodes and silently truncates above
// it. Page explicitly so growth can never quietly lose the tail.
async function fetchAllCategories() {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('job_categories')
      .select('id, name, parent_id')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to load categories: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Denormalise the tree into one row per leaf with its ancestry inlined, so the
 * scorer needs no tree walking: leaf lookup, ancestor chain and root grouping
 * all fall out of a single array.
 */
function buildTaxonomy(rows) {
  const byId = new Map(rows.map((c) => [c.id, c]));
  const parentIds = new Set(rows.filter((c) => c.parent_id).map((c) => c.parent_id));
  const leaves = rows.filter((c) => !parentIds.has(c.id));

  const chainOf = (node) => {
    const chain = [];
    for (let cur = node, hops = 0; cur; cur = cur.parent_id ? byId.get(cur.parent_id) : null) {
      chain.unshift(cur);
      // Defensive: a cycle in parent_id would otherwise hang the build.
      if (++hops > 16) throw new Error(`Cycle or excessive depth at category ${node.id}`);
    }
    return chain;
  };

  const out = leaves.map((leaf) => {
    const chain = chainOf(leaf);
    const root = chain[0];
    // A 2-level branch (root -> leaf) has no group; fall back to the root so
    // every leaf carries both fields and consumers never branch on undefined.
    const group = chain.length >= 3 ? chain[chain.length - 2] : root;
    return {
      id: leaf.id,
      name: leaf.name,
      groupId: group.id,
      group: group.name,
      rootId: root.id,
      root: root.name,
      depth: chain.length,
    };
  });

  // Sort by (root, group, name) so a no-op regeneration produces an empty diff.
  out.sort((a, b) => a.root.localeCompare(b.root)
    || a.group.localeCompare(b.group)
    || a.name.localeCompare(b.name));

  const roots = [...new Map(rows.filter((c) => !c.parent_id).map((c) => [c.id, c.name]))]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    counts: {
      nodes: rows.length,
      roots: roots.length,
      groups: new Set(out.map((l) => l.groupId)).size,
      leaves: out.length,
    },
    roots,
    leaves: out,
  };
}

function serialise(taxonomy) {
  return `${JSON.stringify(taxonomy, null, 2)}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const rows = await fetchAllCategories();

  // A truncated read would silently shrink the taxonomy and degrade matching
  // everywhere. Refuse rather than write a partial file.
  if (rows.length < 300) {
    throw new Error(
      `Only ${rows.length} categories returned; expected ~392. Refusing to write a truncated taxonomy.`,
    );
  }

  const taxonomy = buildTaxonomy(rows);
  const next = serialise(taxonomy);

  console.log(
    `Taxonomy: ${taxonomy.counts.nodes} nodes, ${taxonomy.counts.roots} roots, `
    + `${taxonomy.counts.groups} groups, ${taxonomy.counts.leaves} leaves`,
  );

  if (check) {
    const current = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
    // generatedAt moves every day; compare everything else.
    const strip = (s) => s.replace(/^\s*"generatedAt".*$/m, '');
    if (strip(current) === strip(next)) {
      console.log('taxonomy.generated.json is up to date.');
      return;
    }
    console.error('taxonomy.generated.json is STALE — run: node scripts/syncTaxonomy.js');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT_PATH, next);
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
