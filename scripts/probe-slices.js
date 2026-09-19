/**
 * Validate a board's candidate slice list against the live site.
 *
 * Exists because two boards cannot be verified from a developer machine:
 * NaukriGulf returns ERR_HTTP2_PROTOCOL_ERROR on every path (including the one
 * CI scrapes successfully) and JobsInJapan 403s after the first request. A
 * GitHub runner egresses from the same network the production scraper uses, so
 * a green probe there is the only evidence that counts —
 * see .github/workflows/probe-slices.yml.
 *
 * Usage:
 *   node scripts/probe-slices.js naukrigulf
 *   node scripts/probe-slices.js jobsinjapan
 *   node scripts/probe-slices.js avjobs
 *
 * Read-only: never touches Supabase, always exits 0.
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOARDS = {
  naukrigulf: {
    // Candidate vertical keywords. The scraper is hard-wired to
    // /software-engineer-jobs; these are the untested siblings.
    slices: [
      'software-engineer-jobs', 'accountant-jobs', 'sales-jobs', 'hr-jobs',
      'marketing-jobs', 'finance-jobs', 'civil-engineer-jobs', 'mechanical-engineer-jobs',
    ],
    url: (s) => `https://www.naukrigulf.com/${s}?easyApply=false`,
    count: (html) => (html.match(/ng-box srp-tuple/g) || []).length,
    playwright: true,
    delayMs: 2500,
  },
  jobsinjapan: {
    slices: ['software', 'sales', 'marketing', 'finance', 'designer', 'engineer', 'teacher'],
    url: (s) => `https://jobsinjapan.com/?s=${encodeURIComponent(s)}&post_type=noo_job`,
    count: (html) => (html.match(/\/job\//g) || []).length,
    playwright: true,
    // This board 403s a burst. Probe with the scraper's own pacing: the gate to
    // enable verticals is "N sequential searches all returned results", not
    // "one URL returned 200".
    delayMs: 6000,
  },
  avjobs: {
    slices: [
      'rss_public_mgt_eng.asp', 'rss_public_all.asp', 'rss_public_maint.asp',
      'rss_public_ops.asp', 'rss_public_pilot.asp',
    ],
    url: (s) => `https://www.avjobs.com/special/RSS/${s}`,
    count: (xml) => (xml.match(/<item>/gi) || []).length,
    playwright: false,
    delayMs: 1000,
  },
};

async function probeAxios(board, slice) {
  const started = Date.now();
  try {
    const res = await axios.get(board.url(slice), {
      headers: HEADERS, timeout: 30000, validateStatus: () => true,
    });
    return {
      slice, status: res.status, items: board.count(String(res.data || '')), ms: Date.now() - started,
    };
  } catch (err) {
    return { slice, status: err.code || 'ERR', items: 0, ms: Date.now() - started, error: err.message };
  }
}

async function probePlaywright(board) {
  const { launchStealthBrowser } = require('../lib/scraperUtils');
  const results = [];
  let browser;
  try {
    browser = await launchStealthBrowser();
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();

    for (const slice of board.slices) {
      const started = Date.now();
      try {
        const res = await page.goto(board.url(slice), {
          waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForTimeout(1500);
        const html = await page.content();
        results.push({
          slice, status: res ? res.status() : '?', items: board.count(html), ms: Date.now() - started,
        });
      } catch (err) {
        results.push({
          slice, status: 'ERR', items: 0, ms: Date.now() - started, error: err.message.slice(0, 80),
        });
      }
      await sleep(board.delayMs);
    }
  } catch (err) {
    console.error(`probe: browser failed to launch: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return results;
}

async function main() {
  const name = (process.argv[2] || '').toLowerCase();
  const board = BOARDS[name];
  if (!board) {
    console.error(`Unknown board "${name}". Known: ${Object.keys(BOARDS).join(', ')}`);
    return;
  }

  console.log(`Probing ${name} (${board.slices.length} slices, `
    + `${board.playwright ? 'playwright' : 'axios'})\n`);

  let results;
  if (board.playwright) {
    results = await probePlaywright(board);
  } else {
    results = [];
    for (const slice of board.slices) {
      results.push(await probeAxios(board, slice));
      await sleep(board.delayMs);
    }
  }

  console.log('slice'.padEnd(34) + 'status'.padEnd(10) + 'items'.padEnd(8) + 'ms');
  for (const r of results) {
    console.log(
      String(r.slice).padEnd(34)
      + String(r.status).padEnd(10)
      + String(r.items).padEnd(8)
      + r.ms
      + (r.error ? `  ${r.error}` : ''),
    );
  }

  const working = results.filter((r) => r.items > 0);
  console.log(`\n${working.length}/${results.length} slices returned jobs`);
  if (working.length === results.length && results.length > 1) {
    console.log(`All slices healthy — safe to enable verticals for ${name}.`);
  } else {
    console.log('Not all slices returned jobs; keep the vertical flag disabled for this board.');
  }
}

main().catch((err) => console.error(err.message));
