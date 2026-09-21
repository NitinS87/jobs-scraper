const test = require('node:test');
const assert = require('node:assert');

const {
  contentHash,
  classifyJob,
  planCategorySync,
  chunk,
  chunkByUrlBudget,
  stripUnwritableOnUpdate,
  groupByKeySignature,
} = require('../lib/uploadPlanner');

test('contentHash is stable across key order', () => {
  const a = { title: 'Backend Engineer', location: 'Remote', salary_min: 100 };
  const b = { salary_min: 100, location: 'Remote', title: 'Backend Engineer' };
  assert.equal(contentHash(a), contentHash(b));
});

test('contentHash changes when any written field changes', () => {
  const base = { title: 'Backend Engineer', location: 'Remote' };
  assert.notEqual(contentHash(base), contentHash({ ...base, location: 'Berlin' }));
});

test('contentHash ignores fields the update path never writes', () => {
  // is_active/popular are stripped on update, so they must not participate in the
  // hash or every existing row would look changed forever.
  const base = { title: 'X', is_active: true, popular: false };
  const flipped = { title: 'X', is_active: false, popular: true };
  assert.equal(contentHash(base), contentHash(flipped));
});

test('contentHash ignores content_hash itself', () => {
  const a = { title: 'X' };
  const b = { title: 'X', content_hash: 'deadbeef' };
  assert.equal(contentHash(a), contentHash(b));
});

test('contentHash treats absent and null as the same value', () => {
  assert.equal(contentHash({ title: 'X' }), contentHash({ title: 'X', salary_min: null }));
});

test('contentHash is order-sensitive for array fields', () => {
  // skills order is meaningful to the UI, so a reorder is a real change.
  assert.notEqual(
    contentHash({ skills: ['go', 'rust'] }),
    contentHash({ skills: ['rust', 'go'] })
  );
});

test('classifyJob: unseen external id is an insert', () => {
  assert.equal(classifyJob({ existing: null, record: { title: 'X' }, hasContentHash: true }), 'insert');
});

test('classifyJob: matching stored hash is unchanged', () => {
  const record = { title: 'X' };
  const existing = { id: 'j1', content_hash: contentHash(record) };
  assert.equal(classifyJob({ existing, record, hasContentHash: true }), 'unchanged');
});

test('classifyJob: differing stored hash is an update', () => {
  const existing = { id: 'j1', content_hash: contentHash({ title: 'OLD' }) };
  assert.equal(classifyJob({ existing, record: { title: 'NEW' }, hasContentHash: true }), 'update');
});

test('classifyJob: row with no stored hash must update, never skip', () => {
  // Rows written before the content_hash migration carry null. Skipping them
  // would freeze stale content in place permanently.
  const existing = { id: 'j1', content_hash: null };
  assert.equal(classifyJob({ existing, record: { title: 'X' }, hasContentHash: true }), 'update');
});

test('classifyJob: with the column absent, every existing row updates', () => {
  const record = { title: 'X' };
  const existing = { id: 'j1', content_hash: contentHash(record) };
  assert.equal(classifyJob({ existing, record, hasContentHash: false }), 'update');
});

test('planCategorySync: identical sets produce no writes', () => {
  const plan = planCategorySync(['a', 'b'], new Set(['a', 'b']));
  assert.equal(plan.unchanged, true);
  assert.deepEqual(plan.toInsert, []);
  assert.deepEqual(plan.toDelete, []);
});

test('planCategorySync: set order does not matter', () => {
  assert.equal(planCategorySync(['b', 'a'], new Set(['a', 'b'])).unchanged, true);
});

test('planCategorySync: added categories insert without deleting', () => {
  const plan = planCategorySync(['a', 'b'], new Set(['a']));
  assert.deepEqual(plan.toInsert, ['b']);
  assert.deepEqual(plan.toDelete, []);
  assert.equal(plan.unchanged, false);
});

test('planCategorySync: removed categories delete only what was removed', () => {
  // The old code issued a blanket DELETE for the whole job. Deleting only the
  // dropped ids is what removes 510K DELETEs from the run.
  const plan = planCategorySync(['a'], new Set(['a', 'b', 'c']));
  assert.deepEqual(plan.toInsert, []);
  assert.deepEqual(plan.toDelete.sort(), ['b', 'c']);
});

test('planCategorySync: simultaneous add and remove', () => {
  const plan = planCategorySync(['a', 'c'], new Set(['a', 'b']));
  assert.deepEqual(plan.toInsert, ['c']);
  assert.deepEqual(plan.toDelete, ['b']);
});

test('planCategorySync: empty on both sides is unchanged', () => {
  const plan = planCategorySync([], new Set());
  assert.equal(plan.unchanged, true);
});

test('planCategorySync: clearing all categories deletes them', () => {
  const plan = planCategorySync([], new Set(['a']));
  assert.deepEqual(plan.toDelete, ['a']);
  assert.equal(plan.unchanged, false);
});

test('stripUnwritableOnUpdate removes fields that must survive an update', () => {
  const out = stripUnwritableOnUpdate({
    title: 'X', is_active: true, popular: true, posted_at: '2026-01-01', source_posted_at: '2026-01-01',
  });
  assert.equal('is_active' in out, false);
  assert.equal('popular' in out, false);
  assert.equal(out.posted_at, '2026-01-01');
});

test('stripUnwritableOnUpdate drops null posted_at so it cannot erase a known date', () => {
  const out = stripUnwritableOnUpdate({ title: 'X', posted_at: null, source_posted_at: null });
  assert.equal('posted_at' in out, false);
  assert.equal('source_posted_at' in out, false);
});

test('stripUnwritableOnUpdate returns uniform keys for equal-shaped records', () => {
  // PostgREST bulk upsert requires every object in the payload to have the same
  // keys, so two records with the same populated fields must strip identically.
  const a = stripUnwritableOnUpdate({ title: 'A', posted_at: '2026-01-01', is_active: true });
  const b = stripUnwritableOnUpdate({ title: 'B', posted_at: '2026-02-02', is_active: true });
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
});

test('chunk splits to the requested size and keeps every element', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 10), []);
  assert.deepEqual(chunk([1], 10), [[1]]);
});

test('groupByKeySignature splits records whose key sets differ', () => {
  // PostgREST rejects a bulk payload whose objects have different keys
  // (PGRST102). stripUnwritableOnUpdate drops posted_at only when it is null,
  // so a mixed batch is the normal case, not an edge case.
  const withDate = { title: 'A', posted_at: '2026-01-01' };
  const withoutDate = { title: 'B' };
  const groups = groupByKeySignature([withDate, withoutDate, { title: 'C', posted_at: '2026-02-02' }]);

  assert.equal(groups.length, 2);
  const sizes = groups.map((g) => g.length).sort();
  assert.deepEqual(sizes, [1, 2]);
  for (const g of groups) {
    const sig = Object.keys(g[0]).sort().join('|');
    for (const r of g) assert.equal(Object.keys(r).sort().join('|'), sig);
  }
});

test('groupByKeySignature keeps a uniform batch in one group', () => {
  const groups = groupByKeySignature([{ a: 1, b: 2 }, { b: 3, a: 4 }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test('groupByKeySignature loses no records', () => {
  const input = [{ a: 1 }, { a: 1, b: 2 }, { c: 3 }, { a: 9 }];
  const total = groupByKeySignature(input).reduce((n, g) => n + g.length, 0);
  assert.equal(total, input.length);
});

test('groupByKeySignature handles an empty input', () => {
  assert.deepEqual(groupByKeySignature([]), []);
});

test('contentHash ignores posted_at drift', () => {
  // sourcingxpress and englishjobs derive posted_at from a relative date
  // ("2 days ago") against the clock at scrape time, so it moves by
  // milliseconds on every run. Hashing it made every row look changed forever
  // and defeated no-op skipping entirely (measured: 9/9 rows drifting per run).
  const a = { title: 'X', posted_at: '2026-09-07T04:45:59.281Z', source_posted_at: '2026-09-07T04:45:59.281Z' };
  const b = { title: 'X', posted_at: '2026-09-07T04:46:04.121Z', source_posted_at: '2026-09-07T04:46:04.121Z' };
  assert.equal(contentHash(a), contentHash(b));
});

test('contentHash ignores posted_at drift across days too', () => {
  // A relative date re-resolved tomorrow lands a day later. Same noise.
  const a = { title: 'X', posted_at: '2026-09-07T04:45:59.281Z' };
  const b = { title: 'X', posted_at: '2026-09-08T04:45:59.281Z' };
  assert.equal(contentHash(a), contentHash(b));
});

test('a real content change still updates even when the date also drifted', () => {
  const stored = contentHash({ title: 'OLD', posted_at: '2026-09-07T04:45:59.281Z' });
  const fresh = { title: 'NEW', posted_at: '2026-09-07T04:46:04.121Z' };
  assert.equal(classifyJob({ existing: { id: 'j1', content_hash: stored }, record: fresh, hasContentHash: true }), 'update');
});

test('posted_at is still written even though it is not hashed', () => {
  // Excluded from the hash, not from the payload.
  const out = stripUnwritableOnUpdate({ title: 'X', posted_at: '2026-09-07T00:00:00.000Z' });
  assert.equal(out.posted_at, '2026-09-07T00:00:00.000Z');
});

test('chunkByUrlBudget keeps slices within the character budget', () => {
  // PostgREST puts .in() lists in the query string. 500 ids of ~48 chars build
  // an ~24 KB URL that the edge rejects as a bare "TypeError: fetch failed" —
  // measured 2026-09-20 on a 396-job GetSetHire insert, which silently lost the
  // category mappings for every one of those jobs.
  const ids = Array.from({ length: 396 }, (_, i) => `getsethire-d9967eca-e37c-4f09-90b1-${String(i).padStart(12, '0')}`);
  const slices = chunkByUrlBudget(ids, 500);

  assert.ok(slices.length > 1, 'a 396-id batch must be split, not sent as one URL');
  for (const slice of slices) {
    assert.ok(slice.join(',').length <= 3000, `slice of ${slice.length} exceeded the URL budget`);
  }
  assert.equal(slices.flat().length, ids.length, 'no id may be dropped');
  assert.deepEqual(slices.flat(), ids, 'order must be preserved');
});

test('chunkByUrlBudget still honours the count cap for short values', () => {
  const ids = Array.from({ length: 250 }, (_, i) => `x${i}`);
  const slices = chunkByUrlBudget(ids, 100);
  assert.deepEqual(slices.map((s) => s.length), [100, 100, 50]);
});

test('chunkByUrlBudget never emits an empty slice, even for oversized values', () => {
  // A single value longer than the whole budget still has to go somewhere.
  const huge = 'y'.repeat(5000);
  const slices = chunkByUrlBudget([huge, 'z'], 500);
  assert.ok(slices.every((s) => s.length > 0), 'empty slices would send a pointless request');
  assert.equal(slices.flat().length, 2);
});
