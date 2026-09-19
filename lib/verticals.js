/**
 * Which taxonomy roots ("verticals") a given run collects.
 *
 * The whole-run budget is already oversubscribed — the 15 original scrapers
 * take ~34 min against a 50-min soft budget, and the tail is visibly starved in
 * production. Fetching all 19 roots from every board on every run does not fit,
 * so each run takes a rotating slice and the corpus accumulates across runs, the
 * same way lib/recency.js lets the recency window accumulate.
 *
 * Modelled on lib/recency.js: a pure core plus a memoized env-reading wrapper.
 */
const taxonomy = require('./taxonomy.generated.json');

const SLOT_MS = 6 * 60 * 60 * 1000; // matches the `0 *\/6 * * *` cron
const DEFAULT_PER_RUN = 6;

// Software is pinned to every run: it is 10,090 of the mapped corpus and its
// 6-hourly freshness must not regress to make room for the other 18 roots.
const DEFAULT_PINNED = ['software-internet-ai'];

const slugify = (name) => String(name)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const parseList = (v) => String(v || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const envFlag = (name) => /^(1|true|yes|on)$/i.test(process.env[name] || '');

/** Every root slug in the taxonomy, sorted. */
function allRoots() {
  // Sorted by slug, NOT by taxonomy order: regenerating taxonomy.generated.json
  // must not silently reshuffle which roots a given slot collects.
  return taxonomy.roots.map((r) => slugify(r.name)).sort();
}

/**
 * Pure rotation. Exported for tests so the clock can be injected.
 *
 * @param {object} opts
 * @param {number} opts.now epoch ms
 * @param {string[]} opts.roots all available root slugs
 * @param {string[]} [opts.pinned] always-active roots
 * @param {number} [opts.perRun] rotating roots per run
 * @param {string[]} [opts.only] explicit override; skips rotation entirely
 * @param {string[]} [opts.skip] roots to drop, even if pinned
 * @param {boolean} [opts.all] take every root
 * @param {number} [opts.slotMs]
 * @returns {{active: string[], slot: number, label: string}}
 */
function computeActiveVerticals(opts) {
  const {
    now, roots, pinned = DEFAULT_PINNED, perRun = DEFAULT_PER_RUN,
    only = [], skip = [], all = false, slotMs = SLOT_MS,
  } = opts;

  const known = new Set(roots);
  const slot = Math.floor(now / slotMs);

  let active;
  if (all) {
    active = [...roots];
  } else if (only.length) {
    // Unknown slugs are dropped rather than thrown on: a typo in a repo
    // Variable must not take the scheduled run down.
    active = [...pinned, ...only].filter((r) => known.has(r));
  } else {
    const rotating = roots.filter((r) => !pinned.includes(r));
    const take = Math.max(0, Math.min(perRun, rotating.length));
    const window = [];
    if (rotating.length) {
      const start = (slot * take) % rotating.length;
      for (let i = 0; i < take; i += 1) window.push(rotating[(start + i) % rotating.length]);
    }
    active = [...pinned.filter((r) => known.has(r)), ...window];
  }

  const skipSet = new Set(skip);
  active = [...new Set(active)].filter((r) => !skipSet.has(r));

  const label = `slot ${slot} · ${active.length}/${roots.length} roots: ${active.join(', ') || '(none)'}`;
  return { active, slot, label };
}

let cached = null;

/**
 * Memoized per process. Deliberately NOT computed at module load: a 50-minute
 * run must not have its vertical set change under the last scraper when the
 * clock crosses a slot boundary mid-run.
 */
function getActiveVerticals() {
  if (cached) return cached;

  const roots = allRoots();
  const perRunRaw = Number(process.env.VERTICALS_PER_RUN);
  const pinned = parseList(process.env.VERTICALS_PINNED);

  cached = computeActiveVerticals({
    now: Date.now(),
    roots,
    pinned: pinned.length ? pinned : DEFAULT_PINNED,
    perRun: Number.isFinite(perRunRaw) && perRunRaw >= 0 ? perRunRaw : DEFAULT_PER_RUN,
    only: parseList(process.env.VERTICALS_ONLY),
    skip: parseList(process.env.VERTICALS_SKIP),
    all: envFlag('VERTICALS_ALL') || envFlag('FULL_BACKFILL'),
    slotMs: Number(process.env.VERTICALS_SLOT_MS) || SLOT_MS,
  });
  return cached;
}

function isVerticalActive(slug) {
  return getActiveVerticals().active.includes(slug);
}

/**
 * Resolve a board's slice list for this run.
 *
 * Slices for pinned roots come first, because callers truncate at the tail and
 * the pinned root must never be the one cut.
 *
 * @param {string} source board name, for logging and <SOURCE>_* env lookups
 * @param {Record<string, string[]>} sliceMap root slug -> that board's slices
 * @param {{defaultMaxJobs?: number}} [opts]
 */
function activeSlices(source, sliceMap, opts = {}) {
  const { active } = getActiveVerticals();
  const pinned = parseList(process.env.VERTICALS_PINNED);
  const pinnedSet = new Set(pinned.length ? pinned : DEFAULT_PINNED);

  const ordered = [
    ...active.filter((r) => pinnedSet.has(r)),
    ...active.filter((r) => !pinnedSet.has(r)),
  ];

  const seen = new Set();
  const slices = [];
  const roots = [];
  for (const root of ordered) {
    const forRoot = sliceMap[root] || [];
    if (forRoot.length) roots.push(root);
    for (const slice of forRoot) {
      // Boards commonly serve several roots from one feed (WWR's
      // sales-and-marketing covers both Sales and Marketing) — fetch it once.
      if (seen.has(slice)) continue;
      seen.add(slice);
      slices.push(slice);
    }
  }

  const key = source.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const cap = Number(process.env[`${key}_MAX_JOBS`]) || opts.defaultMaxJobs || Infinity;
  const explicitPerVertical = Number(process.env[`${key}_MAX_JOBS_PER_VERTICAL`])
    || Number(process.env.MAX_JOBS_PER_VERTICAL);

  // Per-vertical caps SUBDIVIDE the board total; they never raise it, so every
  // existing <SOURCE>_MAX_JOBS keeps its current meaning.
  const capPerVertical = getActiveVerticals().active.length && Number.isFinite(cap)
    ? (explicitPerVertical || Math.max(25, Math.ceil(cap / Math.max(roots.length, 1))))
    : (explicitPerVertical || Infinity);

  return {
    slices,
    roots,
    cap,
    capPerVertical,
    label: `${source}: ${slices.length} slices across ${roots.length} active roots`,
  };
}

/** Test seam — clears the per-process memo. */
function _reset() {
  cached = null;
}

module.exports = {
  SLOT_MS,
  DEFAULT_PER_RUN,
  DEFAULT_PINNED,
  slugify,
  allRoots,
  computeActiveVerticals,
  getActiveVerticals,
  isVerticalActive,
  activeSlices,
  _reset,
};
