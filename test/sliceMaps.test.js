const test = require('node:test');
const assert = require('node:assert');

const { allRoots, computeActiveVerticals, SLOT_MS } = require('../lib/verticals');

// Boards whose slice lists are keyed by taxonomy root.
const BOARDS = {
  Teal: require('../scrapers/teal').SLICE_MAP,
  Cimix: require('../scrapers/cimix').SLICE_MAP,
  FINN: require('../scrapers/finn').SLICE_MAP,
};

// Roots no board can serve. Keeping this explicit means adding a 20th root to
// the taxonomy fails the test below instead of silently going uncollected.
const UNMAPPED_ROOTS = [];

const ROOTS = new Set(allRoots());

test('every slice-map key is a real taxonomy root', () => {
  const bad = [];
  for (const [board, map] of Object.entries(BOARDS)) {
    for (const key of Object.keys(map)) {
      if (!ROOTS.has(key)) bad.push(`${board}: "${key}"`);
    }
  }
  assert.deepEqual(bad, [], 'slice maps reference roots that do not exist in the taxonomy');
});

test('every taxonomy root is served by at least one board', () => {
  const served = new Set();
  for (const map of Object.values(BOARDS)) {
    for (const [root, slices] of Object.entries(map)) {
      if (slices && slices.length) served.add(root);
    }
  }
  const orphans = [...ROOTS].filter((r) => !served.has(r) && !UNMAPPED_ROOTS.includes(r));
  assert.deepEqual(
    orphans,
    [],
    'these roots have no board configured to collect them; map them or list them in UNMAPPED_ROOTS',
  );
});

test('no slice map has an empty slice list', () => {
  const empty = [];
  for (const [board, map] of Object.entries(BOARDS)) {
    for (const [root, slices] of Object.entries(map)) {
      if (!slices || !slices.length) empty.push(`${board}.${root}`);
    }
  }
  assert.deepEqual(empty, [], 'an empty slice list makes a root look served when it is not');
});

test('across a full rotation cycle every board reaches all of its roots', () => {
  // Three slots at the default K=6 cover all 18 rotating roots, so no board
  // should have a mapped root it never fetches.
  const roots = allRoots();
  const visited = new Set();
  for (let slot = 0; slot < 3; slot += 1) {
    for (const r of computeActiveVerticals({ now: slot * SLOT_MS, roots }).active) visited.add(r);
  }

  for (const [board, map] of Object.entries(BOARDS)) {
    const unreachable = Object.keys(map).filter((r) => !visited.has(r));
    assert.deepEqual(unreachable, [], `${board} has roots the rotation never activates`);
  }
});
