const crypto = require('crypto');

/**
 * Pure planning helpers for the uploader. Kept free of any Supabase calls so the
 * batching decisions — which are what the whole egress reduction rests on — can
 * be tested without a database.
 */

// Fields excluded from the content hash.
//
// is_active is owned by the 90-day expiry job and popular by the app; hashing
// them would mark every deactivated row as "changed" on every run.
//
// posted_at / source_posted_at are excluded because some scrapers (sourcingxpress,
// englishjobs) resolve a relative date ("2 days ago") against the clock at scrape
// time, so the value drifts on every single run — measured at 9/9 rows drifting
// per run, which defeated no-op skipping completely. They are still written; they
// just do not on their own justify rewriting an 8.9 KB row. For a relative date
// the first-observed value is also the closest to the true publication time.
const HASH_EXCLUDED_FIELDS = new Set([
  'is_active',
  'popular',
  'content_hash',
  'posted_at',
  'source_posted_at',
]);

// Dropped from an update so a re-scrape that lost the date cannot erase it.
const NULLABLE_DATE_FIELDS = ['posted_at', 'source_posted_at'];

// Never overwritten on an existing row.
const UPDATE_STRIPPED_FIELDS = ['is_active', 'popular'];

function canonicalize(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (HASH_EXCLUDED_FIELDS.has(key)) continue;
      const v = canonicalize(value[key]);
      if (v === null) continue; // absent and null must hash alike
      out[key] = v;
    }
    return out;
  }
  return value;
}

/** Stable digest of the fields an update would actually write. */
function contentHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(record))).digest('hex');
}

/**
 * Decide what this job needs. `existing` is the prefetched {id, content_hash}
 * row, or null when the external id was not found.
 *
 * A null stored hash means the row predates the content_hash migration — it must
 * update, because we cannot prove it is current.
 */
function classifyJob({ existing, record, hasContentHash }) {
  if (!existing) return 'insert';
  if (!hasContentHash) return 'update';
  if (!existing.content_hash) return 'update';
  return existing.content_hash === contentHash(record) ? 'unchanged' : 'update';
}

/**
 * Diff the resolved category set against what is stored. The old code issued a
 * blanket DELETE plus a full re-INSERT for every job on every run; deleting only
 * the dropped ids is what removes that traffic.
 */
function planCategorySync(desiredIds, priorIds) {
  const desired = new Set(desiredIds);
  const prior = priorIds || new Set();

  const toInsert = [...desired].filter((id) => !prior.has(id));
  const toDelete = [...prior].filter((id) => !desired.has(id));

  return { toInsert, toDelete, unchanged: toInsert.length === 0 && toDelete.length === 0 };
}

/** Remove the fields an update must not touch, plus dates that came back null. */
function stripUnwritableOnUpdate(record) {
  const out = { ...record };
  for (const field of UPDATE_STRIPPED_FIELDS) delete out[field];
  for (const field of NULLABLE_DATE_FIELDS) {
    if (out[field] === null || out[field] === undefined) delete out[field];
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// PostgREST puts `.in()` lists in the query string, so a batch is bounded by URL
// length, not row count. 500 external ids (~48 chars) or 500 job UUIDs (~37) build
// an 18-25 KB URL, which the edge rejects outright — the client reports it as a
// bare "TypeError: fetch failed".
//
// Measured 2026-09-20: a 396-job GetSetHire insert failed exactly this way, and
// because resolveInsertedIds has no fallback it silently returned an empty map
// and every one of those jobs landed with no category mappings.
const DEFAULT_URL_BUDGET = 3000;

/**
 * Split values so each slice stays within a character budget as well as a count
 * cap. Keeps batching O(1)-ish in requests without building an unsendable URL.
 *
 * @param {string[]} values
 * @param {number} maxCount hard cap on slice length
 * @param {number} [maxChars] budget for the joined values, excluding separators
 */
function chunkByUrlBudget(values, maxCount, maxChars = DEFAULT_URL_BUDGET) {
  const out = [];
  let current = [];
  let width = 0;

  for (const v of values) {
    // +3 approximates the comma and any percent-encoded quoting per value.
    const cost = String(v).length + 3;
    if (current.length && (current.length >= maxCount || width + cost > maxChars)) {
      out.push(current);
      current = [];
      width = 0;
    }
    current.push(v);
    width += cost;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Split records into groups that share an identical key set.
 *
 * PostgREST rejects a bulk payload whose objects have different keys (PGRST102),
 * and stripUnwritableOnUpdate drops posted_at only when it is null — so a batch
 * mixing dated and undated jobs is the normal case.
 */
function groupByKeySignature(records) {
  const groups = new Map();
  for (const record of records) {
    const signature = Object.keys(record).sort().join('|');
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(record);
  }
  return [...groups.values()];
}

module.exports = {
  chunkByUrlBudget,
  DEFAULT_URL_BUDGET,
  contentHash,
  classifyJob,
  planCategorySync,
  stripUnwritableOnUpdate,
  chunk,
  groupByKeySignature,
  HASH_EXCLUDED_FIELDS,
};
