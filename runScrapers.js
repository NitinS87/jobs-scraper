require('dotenv').config();
const { processScraperResults } = require('./lib/uploader');
const { withTimeout } = require('./lib/scraperUtils');
const { getRecencyConfig } = require('./lib/recency');
const { getActiveVerticals } = require('./lib/verticals');

// Node 22 treats an unhandled rejection as fatal, which took down the whole
// 22-scraper pipeline mid-run: playwright-extra's stealth plugin emits
// "cdpSession.send: Target page, context or browser has been closed" from an
// async internal handler when a navigation dies (seen in NaukriGulf), and no
// try/catch inside the scraper can reach it. One flaky page should cost us that
// scraper, not every scraper queued behind it. Logged loudly, never silently.
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error(`Unhandled rejection (run continues): ${msg}`);
});

const RUN_STARTED_AT = Date.now();
const recency = getRecencyConfig();

// Per-scraper hang guard. This is NOT the budget — RUN_BUDGET_MS is.
const DEFAULT_SCRAPER_TIMEOUT_MS =
  Number(process.env.SCRAPER_TIMEOUT_MS) ||
  (recency.fullBackfill ? 60 * 60 * 1000 : 5 * 60 * 1000);

// Soft cap on the whole run. CI's timeout-minutes is the hard kill; this lets us
// exit cleanly with a summary before GitHub SIGKILLs us mid-upload. Disabled
// during a backfill, which is expected to run long.
//
// Sized from a measured full run: the 15 pre-existing scrapers alone take ~34
// min (GulfTalent 6.6, NaukriGulf 4.3, Cimix 4.0, YCombinator 3.7, HNHiring
// 3.1), so a 35-min budget starved every new source at the tail. 50 min leaves
// the five recency-windowed boards real runway under a 60-min CI hard cap.
const RUN_BUDGET_MS = recency.fullBackfill
  ? Infinity
  : Number(process.env.RUN_BUDGET_MS) || 50 * 60 * 1000;

// Don't start a scraper we can't give a fair slice of time to.
const MIN_SLICE_MS = 45 * 1000;
const UPLOAD_TIMEOUT_MS = Number(process.env.UPLOAD_TIMEOUT_MS) || 10 * 60 * 1000;

// Comma-separated name filters, for targeted backfills: SCRAPER_ONLY=JobbSafari
const parseList = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const only = parseList(process.env.SCRAPER_ONLY);
const skip = parseList(process.env.SCRAPER_SKIP);

const scrapers = [
  { name: 'WeWorkRemotely', fn: require('./scrapers/weworkremotely') },
  { name: 'Jobicy', fn: require('./scrapers/jobicy') },
  { name: 'AVJobs', fn: require('./scrapers/avjobs') },
  { name: 'RealWorkFromAnywhere', fn: require('./scrapers/realworkfromanywhere') },
  { name: 'TokyoDev', fn: require('./scrapers/tokyodev') },
  { name: 'JobsInJapan', fn: require('./scrapers/jobsinjapan') },
  // 8 verticals x pagination + up to 100 sequential detail pages does not fit
  // the 5-minute default; a hard timeout here throws away the entire run
  // (measured 2026-09-20, run 35518373605). The scraper also has its own
  // shorter soft deadline so it yields partial results rather than nothing.
  { name: 'NaukriGulf', fn: require('./scrapers/NaukriGulf-Scraper'), timeoutMs: 8 * 60 * 1000 },
  { name: 'HNHiring', fn: require('./scrapers/hnhiring') },
  { name: 'YCombinator', fn: require('./scrapers/ycombinator') },
  { name: 'CutShort', fn: require('./scrapers/cutshort') },
  { name: 'NCS', fn: require('./scrapers/ncs') },
  { name: 'GulfTalent', fn: require('./scrapers/gulftalent') },
  { name: 'SourcingXpress', fn: require('./scrapers/sourcingxpress') },
  { name: 'Cimix', fn: require('./scrapers/cimix') },
  { name: 'WorkInDenmark', fn: require('./scrapers/workindenmark') },
  // One unauthenticated API call for the whole board — cheapest scraper here.
  { name: 'GetSetHire', fn: require('./scrapers/getsethire'), timeoutMs: 60 * 1000 },
  // Aggregates company career pages for IN/US/CA. Cheap (axios + cheerio, no
  // browser) and carries full JSON-LD, so it sits ahead of the windowed boards.
  { name: 'Hyriko', fn: require('./scrapers/hyriko'), timeoutMs: 4 * 60 * 1000 },

  // Recency-windowed high-volume sources (see lib/recency.js). Ordered
  // cheapest-first: Teal/JobStairs/EnglishJobs need no per-job detail page, so
  // FINN and JobbSafari absorb any budget truncation.
  { name: 'Teal', fn: require('./scrapers/teal'), timeoutMs: 4 * 60 * 1000 },
  { name: 'JobStairs', fn: require('./scrapers/jobstairs'), timeoutMs: 6 * 60 * 1000 },
  { name: 'EnglishJobs', fn: require('./scrapers/englishjobs'), timeoutMs: 4 * 60 * 1000 },
  { name: 'FINN', fn: require('./scrapers/finn'), timeoutMs: 6 * 60 * 1000 },
  { name: 'JobbSafari', fn: require('./scrapers/jobbsafari'), timeoutMs: 6 * 60 * 1000 },

  // Vercel-checkpointed and paced at 8s/detail, so it is the most expensive
  // job-per-second here — last before the Tier C entries, and the first thing
  // to cut if the run budget overruns.
  { name: 'EchoJobs', fn: require('./scrapers/echojobs'), timeoutMs: 7 * 60 * 1000 },

  { name: 'Wellfound', fn: require('./scrapers/wellfound'), optional: true },
  { name: 'SimplyHiredIN', fn: require('./scrapers/simplyhired'), optional: true },
];

const remainingMs = () => RUN_BUDGET_MS - (Date.now() - RUN_STARTED_AT);
const mins = (ms) => (ms / 60000).toFixed(1);

async function run() {
  console.log(`Recency window: ${recency.label}`);
  // Verticals rotate per run so the whole-run budget is not blown fetching all
  // 19 taxonomy roots from every board; the corpus accumulates across runs.
  console.log(`Verticals: ${getActiveVerticals().label}`);
  console.log(`Run budget: ${RUN_BUDGET_MS === Infinity ? 'unlimited' : `${mins(RUN_BUDGET_MS)} min`}`);
  if (only.length) console.log(`SCRAPER_ONLY: ${only.join(', ')}`);
  if (skip.length) console.log(`SCRAPER_SKIP: ${skip.join(', ')}`);

  const summary = [];

  for (const { name, fn, optional, timeoutMs } of scrapers) {
    const key = name.toLowerCase();
    if (only.length && !only.includes(key)) continue;
    if (skip.includes(key)) {
      console.log(`\nSkipping ${name} (SCRAPER_SKIP)`);
      continue;
    }

    if (optional && process.env.ENABLE_TIER_C_SCRAPERS !== 'true') {
      console.log(`\nSkipping ${name} (Tier C — set ENABLE_TIER_C_SCRAPERS=true to enable)`);
      continue;
    }

    const left = remainingMs();
    if (left < MIN_SLICE_MS) {
      console.warn(
        `\nBudget exhausted (${mins(Date.now() - RUN_STARTED_AT)} min elapsed) — `
        + `skipping ${name} and all remaining scrapers.`
      );
      summary.push({ name, status: 'skipped:budget' });
      break;
    }

    const slice = Math.min(
      timeoutMs || DEFAULT_SCRAPER_TIMEOUT_MS,
      Math.max(left - MIN_SLICE_MS, MIN_SLICE_MS)
    );

    try {
      console.log(`\nRunning ${name}... (timeout ${mins(slice)} min, ${mins(left)} min budget left)`);
      const startedAt = Date.now();

      const jobs = await withTimeout(fn(), slice, `${name} scraper`);
      console.log(`${name}: scraped ${jobs.length} jobs in ${mins(Date.now() - startedAt)} min`);

      const stats = await withTimeout(
        processScraperResults(jobs),
        Math.min(UPLOAD_TIMEOUT_MS, Math.max(remainingMs(), MIN_SLICE_MS)),
        `${name} upload`
      );
      console.log(
        `${name}: inserted=${stats.inserted}, updated=${stats.updated}, `
        + `unchanged=${stats.unchanged || 0}, errors=${stats.errors} `
        + `(${mins(Date.now() - startedAt)} min total)`
      );
      summary.push({ name, status: 'ok', scraped: jobs.length, ...stats });
    } catch (err) {
      console.error(`${name} failed:`, err.message);
      summary.push({ name, status: 'failed', error: err.message });
    }
  }

  console.log(`\nAll scrapers finished in ${mins(Date.now() - RUN_STARTED_AT)} min.`);
  console.table(summary);
}

run();
