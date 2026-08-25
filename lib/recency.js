// Recency-window policy shared by the high-volume scrapers (Teal, JobStairs,
// EnglishJobs, FINN, JobbSafari).
//
// These boards carry 4k-50k listings each, which cannot be fetched inside the
// 6-hourly CI budget. Instead each normal run pulls only jobs posted within
// RECENCY_DAYS (default 7). Because the cron fires every 6h and the uploader
// upserts idempotently by external_source + external_job_id, the full *active*
// corpus accumulates across runs without any persisted cursor.
//
// FULL_BACKFILL=true disables the window entirely; it is meant for manual
// workflow_dispatch runs outside the normal budget, never for the cron path.

const DEFAULT_RECENCY_DAYS = 7;
const DEFAULT_TOLERANCE_PAGES = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

// Job feeds routinely publish slightly-future timestamps (timezone sloppiness,
// scheduled posts). Beyond this we treat the date as unreadable rather than fresh.
const MAX_CLOCK_SKEW_MS = 36 * 60 * 60 * 1000;

const FRESH = 'fresh';
const STALE = 'stale';
const UNKNOWN = 'unknown';

const configCache = new Map();

function envFlag(name) {
  const v = process.env[name];
  return v != null && /^(1|true|yes|on)$/i.test(String(v).trim());
}

// 'JobbSafari' -> 'JOBBSAFARI'
function envKey(source) {
  return String(source || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Resolve the recency window for a source. Memoized, so the cutoff is computed
 * ONCE per process: a cutoff that drifts during a 20-minute run makes the paging
 * guard flap at the window boundary.
 *
 * Env, most specific wins:
 *   <SOURCE>_FULL_BACKFILL / FULL_BACKFILL  -> boolean
 *   <SOURCE>_RECENCY_DAYS  / RECENCY_DAYS   -> days (default 7)
 */
function getRecencyConfig(source) {
  const key = envKey(source);
  if (configCache.has(key)) return configCache.get(key);

  const fullBackfill = envFlag('FULL_BACKFILL') || (!!key && envFlag(`${key}_FULL_BACKFILL`));
  const raw = (key && process.env[`${key}_RECENCY_DAYS`]) || process.env.RECENCY_DAYS;
  const parsed = Number(raw);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECENCY_DAYS;

  let cfg;
  if (fullBackfill) {
    cfg = {
      fullBackfill: true,
      days: Infinity,
      cutoffMs: -Infinity,
      cutoff: null,
      cutoffISO: null,
      label: 'FULL_BACKFILL (no window)',
    };
  } else {
    const cutoffMs = Date.now() - days * DAY_MS;
    const cutoff = new Date(cutoffMs);
    cfg = {
      fullBackfill: false,
      days,
      cutoffMs,
      cutoff,
      cutoffISO: cutoff.toISOString(),
      label: `last ${days}d (since ${cutoff.toISOString().slice(0, 10)})`,
    };
  }

  configCache.set(key, cfg);
  return cfg;
}

/**
 * Tolerant date parser for listing payloads: Date, ISO-8601, epoch seconds,
 * epoch milliseconds, dd.MM.yyyy, dd/MM/yyyy, yyyy-MM-dd. Returns null when the
 * value cannot be trusted.
 */
function parseDateLike(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const s = String(value).trim();
  if (!s) return null;

  // Bare integer: epoch. Below 1e11 means seconds, not milliseconds.
  if (/^\d+$/.test(s)) {
    let n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e11) n *= 1000;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // dd.MM.yyyy / dd/MM/yyyy — day-first, NOT US month-first: every source using
  // this module is European. Parsed as UTC midnight.
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (dmy) {
    const d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** First parseable date among several candidate fields. */
function firstDate(...values) {
  for (const v of values) {
    const d = parseDateLike(v);
    if (d) return d;
  }
  return null;
}

/**
 * Three-state classification. The third state carries real weight: "I could not
 * read a date" is NOT "this is old". Conflating them either drops good jobs or
 * stops paging on the first undated row.
 */
function classifyDate(value, source) {
  const cfg = getRecencyConfig(source);
  if (cfg.fullBackfill) return FRESH;

  const d = parseDateLike(value);
  if (!d) return UNKNOWN;

  const t = d.getTime();
  if (t > Date.now() + MAX_CLOCK_SKEW_MS) return UNKNOWN; // implausible future date
  return t >= cfg.cutoffMs ? FRESH : STALE;
}

/**
 * Keep-or-drop predicate. Undated entries are KEPT: the cost of keeping a stale
 * job is one idempotent upsert, the cost of dropping a fresh one is losing it.
 */
function isWithinWindow(value, source) {
  return classifyDate(value, source) !== STALE;
}

/** Day count for APIs with a native recency parameter (Teal's min_posted_at). */
function recencyApiDays(source) {
  const cfg = getRecencyConfig(source);
  return cfg.fullBackfill ? null : Math.ceil(cfg.days);
}

/**
 * Stateful "should I keep paging?" guard for date-sorted listings.
 *
 *   const guard = createPagingGuard({ source: 'JobStairs', maxJobs: MAX_JOBS });
 *   for (let page = 1; ; page++) {
 *     const raw = await fetchPage(page);
 *     const { items, stop, reason } = guard.observePage(raw, j => j.datePosted);
 *     for (const item of items) { ... }   // only fresh/undated survive
 *     if (stop) { console.log(guard.summary(reason)); break; }
 *   }
 *
 * @param {string}  opts.source          drives <SOURCE>_* env lookups and log lines
 * @param {number} [opts.tolerancePages] consecutive all-stale pages before stopping (default 2).
 *                                       Pass Infinity when date ordering is unreliable.
 * @param {number} [opts.maxPages]       hard page cap (FINN: 50)
 * @param {number} [opts.maxJobs]        hard cap on KEPT items
 * @param {number} [opts.maxEmptyPages]  consecutive empty pages before stopping (default 1)
 */
function createPagingGuard(opts = {}) {
  const source = opts.source || 'scraper';
  const cfg = getRecencyConfig(source);

  const tolerancePages = opts.tolerancePages != null
    ? opts.tolerancePages
    : (Number(process.env.RECENCY_STOP_PAGES) || DEFAULT_TOLERANCE_PAGES);
  const maxPages = opts.maxPages != null ? opts.maxPages : Infinity;
  const maxJobs = opts.maxJobs != null ? opts.maxJobs : Infinity;
  const maxEmptyPages = opts.maxEmptyPages != null ? opts.maxEmptyPages : 1;

  let pages = 0;
  let kept = 0;
  let seen = 0;
  let freshTotal = 0;
  let staleTotal = 0;
  let unknownTotal = 0;
  let coldStreak = 0;
  let emptyStreak = 0;

  return {
    config: cfg,
    get stats() {
      return {
        pages, seen, kept,
        fresh: freshTotal, stale: staleTotal, unknown: unknownTotal,
        coldStreak,
      };
    },

    observePage(rawItems, getDate) {
      pages++;
      const list = Array.isArray(rawItems) ? rawItems : [];
      const pick = typeof getDate === 'function' ? getDate : (x) => x;

      let fresh = 0;
      let stale = 0;
      let unknown = 0;
      const items = [];

      for (const item of list) {
        let value;
        try {
          value = pick(item);
        } catch {
          value = null;
        }
        const c = classifyDate(value, source);
        if (c === STALE) {
          stale++;
          continue;
        }
        if (c === UNKNOWN) unknown++;
        else fresh++;
        if (kept + items.length < maxJobs) items.push(item);
      }

      seen += list.length;
      kept += items.length;
      freshTotal += fresh;
      staleTotal += stale;
      unknownTotal += unknown;

      emptyStreak = list.length === 0 ? emptyStreak + 1 : 0;

      // A page counts as "cold" only if it held at least one CONFIRMED-stale row
      // and zero fresh rows. A page of entirely undated rows is indeterminate: it
      // neither advances nor resets the streak, so a source whose listing carries
      // no dates can never trip the recency stop — it is bounded by maxPages /
      // maxJobs instead. This is the key robustness property of the guard.
      if (fresh > 0) coldStreak = 0;
      else if (stale > 0) coldStreak++;

      let stop = false;
      let reason = null;
      if (emptyStreak >= maxEmptyPages) {
        stop = true;
        reason = 'empty-page';
      } else if (kept >= maxJobs) {
        stop = true;
        reason = 'max-jobs';
      } else if (pages >= maxPages) {
        stop = true;
        reason = 'max-pages';
      } else if (!cfg.fullBackfill && coldStreak >= tolerancePages) {
        stop = true;
        reason = 'recency-window';
      }

      return { items, fresh, stale, unknown, page: pages, kept, stop, reason };
    },

    summary(reason) {
      return `${source}: stopped after ${pages} page(s) [${reason || 'caller'}] — `
        + `window=${cfg.label}, seen=${seen}, kept=${kept} `
        + `(fresh=${freshTotal}, stale=${staleTotal}, undated=${unknownTotal})`;
    },
  };
}

module.exports = {
  DAY_MS,
  FRESH,
  STALE,
  UNKNOWN,
  getRecencyConfig,
  parseDateLike,
  firstDate,
  classifyDate,
  isWithinWindow,
  recencyApiDays,
  createPagingGuard,
};
