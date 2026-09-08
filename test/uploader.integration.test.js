const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { contentHash } = require('../lib/uploadPlanner');

/**
 * Drives processScraperResults against a fake Supabase client that records every
 * request. The unit tests cover the planning decisions; this covers the wiring —
 * specifically that N jobs no longer produce O(N) REST calls, which is the whole
 * point of the change.
 */
function installMock(handlers) {
  const calls = [];

  function builder(table) {
    const state = { table, op: null, columns: null, filters: [], payload: null, opts: null, representation: false };
    const b = {
      select(c) {
        if (state.op) state.representation = true; // .select() after a write => return=representation
        else state.op = 'select';
        state.columns = c;
        return b;
      },
      insert(p) { state.op = 'insert'; state.payload = p; return b; },
      upsert(p, o) { state.op = 'upsert'; state.payload = p; state.opts = o; return b; },
      update(p) { state.op = 'update'; state.payload = p; return b; },
      delete() { state.op = 'delete'; return b; },
      eq(k, v) { state.filters.push(['eq', k, v]); return b; },
      in(k, v) { state.filters.push(['in', k, v]); return b; },
      order() { return b; },
      range(a, z) { state.range = [a, z]; return b; },
      limit(n) { state.limit = n; return b; },
      maybeSingle() { state.single = 'maybe'; return b; },
      single() { state.single = true; return b; },
      then(res, rej) {
        calls.push(state);
        return Promise.resolve()
          .then(() => handlers(state) || { data: null, error: null })
          .then(res, rej);
      },
    };
    return b;
  }

  const logoPath = require.resolve('../lib/logoUploader');
  require.cache[logoPath] = {
    id: logoPath, filename: logoPath, loaded: true,
    exports: {
      downloadAndUploadLogo: async () => null,
      tryExtractLogo: async () => null,
      getGoogleFavicon: async () => null,
    },
  };

  const clientPath = require.resolve('../lib/supabaseClient');
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { from: builder } };

  // Force a fresh uploader bound to the mock, with clean module-level caches.
  for (const p of ['../lib/uploader', '../lib/categoryMatcher']) delete require.cache[require.resolve(p)];
  const uploader = require('../lib/uploader');

  return { uploader, calls };
}

function makeJob(n, overrides = {}) {
  return {
    title: `Backend Engineer ${n}`,
    company: { name: `Acme ${((n - 1) % 3) + 1}` },
    location: 'Remote',
    is_remote: true,
    description: `<p>Build things. Role number ${n}.</p>`,
    external_job_id: `ext-${n}`,
    external_source: 'TestBoard',
    posted_at: '2026-09-01T00:00:00.000Z',
    source_url: `https://example.test/${n}`,
    ...overrides,
  };
}

/** Handler factory: `existing` maps external_job_id -> {id, content_hash}. */
function handlersFor(existing, companies) {
  return (s) => {
    if (s.table === 'job_sources') {
      return s.op === 'select' ? { data: { id: 'src-1' }, error: null } : { data: null, error: null };
    }
    if (s.table === 'job_categories') return { data: [], error: null };
    if (s.table === 'companies') {
      if (s.op === 'select' && s.range) return { data: companies, error: null };
      if (s.op === 'select') return { data: companies, error: null };
      if (s.op === 'insert') return { data: { id: 'new-co' }, error: null };
      return { data: null, error: null };
    }
    if (s.table === 'job_category_mappings') return { data: [], error: null };
    if (s.table === 'jobs') {
      if (s.op === 'select' && s.limit === 1) return { data: [], error: null }; // schema probe: content_hash exists
      if (s.op === 'select') {
        const rows = Object.entries(existing).map(([extId, v]) => ({
          id: v.id, external_job_id: extId, external_source: 'TestBoard', content_hash: v.content_hash,
        }));
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
}

const COMPANIES = Array.from({ length: 3 }, (_, i) => ({
  id: `co-${i + 1}`, name: `Acme ${i + 1}`,
  logo_url: 'x', website: 'https://x.test', location: 'A', industry: 'B', country_code: 'US', description: 'D',
}));

test('unchanged jobs produce zero writes to the jobs table', async () => {
  // Build the records the uploader would produce, then pre-seed their hashes so
  // every job classifies as unchanged.
  const probe = installMock(handlersFor({}, COMPANIES));
  const jobs = [1, 2, 3].map((n) => makeJob(n));
  await probe.uploader.processScraperResults(jobs);
  const upserted = probe.calls.filter((c) => c.table === 'jobs' && c.op === 'upsert').flatMap((c) => c.payload);
  assert.equal(upserted.length, 3, 'precondition: first run inserts all three');

  const existing = {};
  for (const rec of upserted) existing[rec.external_job_id] = { id: `j-${rec.external_job_id}`, content_hash: rec.content_hash };

  const { uploader, calls } = installMock(handlersFor(existing, COMPANIES));
  const stats = await uploader.processScraperResults(jobs);

  assert.equal(stats.unchanged, 3);
  assert.equal(stats.inserted, 0);
  assert.equal(stats.updated, 0);

  const jobWrites = calls.filter((c) => c.table === 'jobs' && c.op !== 'select');
  assert.deepEqual(jobWrites, [], 'a re-run of identical content must not write to jobs at all');

  const mappingWrites = calls.filter((c) => c.table === 'job_category_mappings' && c.op !== 'select');
  assert.deepEqual(mappingWrites, [], 'no DELETE+INSERT churn on unchanged mappings');
});

test('changed jobs collapse into one batched upsert, not one call per job', async () => {
  const jobs = Array.from({ length: 12 }, (_, i) => makeJob(i + 1));
  const existing = {};
  for (let i = 1; i <= 12; i++) existing[`ext-${i}`] = { id: `j-${i}`, content_hash: 'stale-hash' };

  const { uploader, calls } = installMock(handlersFor(existing, COMPANIES));
  const stats = await uploader.processScraperResults(jobs);

  const upserts = calls.filter((c) => c.table === 'jobs' && c.op === 'upsert');
  assert.equal(upserts.length, 1, `expected 1 batched upsert, got ${upserts.length}`);
  assert.equal(upserts[0].payload.length, 12);
  assert.equal(stats.updated, 12);

  const perRowUpdates = calls.filter((c) => c.table === 'jobs' && c.op === 'update');
  assert.deepEqual(perRowUpdates, [], 'must not fall back to per-row UPDATEs');
});

test('write calls never request the row back', async () => {
  const jobs = Array.from({ length: 5 }, (_, i) => makeJob(i + 1));
  const { uploader, calls } = installMock(handlersFor({}, COMPANIES));
  await uploader.processScraperResults(jobs);

  const echoing = calls.filter((c) => ['upsert', 'update', 'delete'].includes(c.op) && c.representation);
  assert.deepEqual(echoing, [], 'no write may chain .select() — that is what ships the 8.9 KB row back');
});

test('updates omit is_active and popular so deactivated jobs are not resurrected', async () => {
  const jobs = [makeJob(1)];
  const { uploader, calls } = installMock(handlersFor({ 'ext-1': { id: 'j-1', content_hash: 'stale' } }, COMPANIES));
  await uploader.processScraperResults(jobs);

  const upsert = calls.find((c) => c.table === 'jobs' && c.op === 'upsert');
  assert.ok(upsert, 'expected an upsert');
  for (const row of upsert.payload) {
    assert.equal('is_active' in row, false, 'is_active in an update would revive expired jobs');
    assert.equal('popular' in row, false, 'popular is owned by the app');
  }
});

test('inserts do carry is_active so new jobs are live', async () => {
  const { uploader, calls } = installMock(handlersFor({}, COMPANIES));
  await uploader.processScraperResults([makeJob(1)]);

  const upsert = calls.find((c) => c.table === 'jobs' && c.op === 'upsert');
  assert.equal(upsert.payload[0].is_active, true);
});

test('request count stays flat as job count grows', async () => {
  const count = (n) => {
    const existing = {};
    for (let i = 1; i <= n; i++) existing[`ext-${i}`] = { id: `j-${i}`, content_hash: 'stale' };
    const jobs = Array.from({ length: n }, (_, i) => makeJob(i + 1));
    const { uploader, calls } = installMock(handlersFor(existing, COMPANIES));
    return uploader.processScraperResults(jobs).then(() => calls.length);
  };

  const small = await count(5);
  const large = await count(200);
  assert.equal(small, large, `request count must not scale with job count (${small} vs ${large})`);
});

test('company lookups do not scale with job count', async () => {
  const jobs = Array.from({ length: 50 }, (_, i) => makeJob((i % 3) + 1));
  const existing = {};
  for (let i = 1; i <= 3; i++) existing[`ext-${i}`] = { id: `j-${i}`, content_hash: 'stale' };

  const { uploader, calls } = installMock(handlersFor(existing, COMPANIES));
  await uploader.processScraperResults(jobs);

  const companySelects = calls.filter((c) => c.table === 'companies' && c.op === 'select');
  assert.ok(companySelects.length <= 3, `expected a prefetch, got ${companySelects.length} company selects`);
});

test('a failed batch lookup degrades to per-job lookups rather than duplicating rows', async () => {
  const jobs = Array.from({ length: 3 }, (_, i) => makeJob(i + 1));
  let firstJobSelect = true;

  const base = handlersFor({}, COMPANIES);
  const { uploader, calls } = installMock((s) => {
    if (s.table === 'jobs' && s.op === 'select' && s.limit !== 1 && firstJobSelect) {
      firstJobSelect = false;
      return { data: null, error: { message: 'boom', code: '500' } };
    }
    return base(s);
  });

  const stats = await uploader.processScraperResults(jobs);
  const perJobLookups = calls.filter(
    (c) => c.table === 'jobs' && c.op === 'select' && c.single === 'maybe'
  );
  assert.equal(perJobLookups.length, 3, 'each job must be looked up individually when the batch fails');
  assert.equal(stats.errors, 0);
});

test('falls back to per-row writes on the real 42P10 from a missing constraint', async () => {
  // Verified against the live project 2026-09-08: upserting on
  // (external_source, external_job_id) returns 42P10 until 001_ingestion_perf.sql
  // is applied. The pipeline must keep working, just at the old cost.
  const jobs = Array.from({ length: 4 }, (_, i) => makeJob(i + 1));
  const existing = {};
  for (let i = 1; i <= 4; i++) existing[`ext-${i}`] = { id: `j-${i}`, content_hash: 'stale' };

  const base = handlersFor(existing, COMPANIES);
  const { uploader, calls } = installMock((s) => {
    if (s.table === 'jobs' && s.op === 'upsert') {
      return {
        data: null,
        error: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' },
      };
    }
    return base(s);
  });

  const stats = await uploader.processScraperResults(jobs);

  const perRow = calls.filter((c) => c.table === 'jobs' && c.op === 'update');
  assert.equal(perRow.length, 4, 'must fall back to one UPDATE per job');
  assert.equal(stats.updated, 4);
  assert.equal(stats.errors, 0, 'a missing constraint is a degraded path, not an error');
});

test('with content_hash absent (real 42703) nothing is skipped', async () => {
  const jobs = Array.from({ length: 3 }, (_, i) => makeJob(i + 1));
  const existing = {};
  for (let i = 1; i <= 3; i++) existing[`ext-${i}`] = { id: `j-${i}`, content_hash: null };

  const base = handlersFor(existing, COMPANIES);
  const { uploader } = installMock((s) => {
    if (s.table === 'jobs' && s.op === 'select' && s.limit === 1) {
      return { data: null, error: { code: '42703', message: 'column jobs.content_hash does not exist' } };
    }
    return base(s);
  });

  const stats = await uploader.processScraperResults(jobs);
  assert.equal(stats.unchanged, 0, 'without the column we cannot prove a row is current');
  assert.equal(stats.updated, 3);
});

test('no content_hash column means no content_hash in the payload', async () => {
  const base = handlersFor({}, COMPANIES);
  const { uploader, calls } = installMock((s) => {
    if (s.table === 'jobs' && s.op === 'select' && s.limit === 1) {
      return { data: null, error: { code: '42703', message: 'column jobs.content_hash does not exist' } };
    }
    return base(s);
  });

  await uploader.processScraperResults([makeJob(1)]);
  const upsert = calls.find((c) => c.table === 'jobs' && c.op === 'upsert');
  assert.equal('content_hash' in upsert.payload[0], false, 'would 400 against the current schema');
});
