const playwright = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgent = require('user-agents');

playwright.chromium.use(StealthPlugin());

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return delay(ms);
}

function isCloudflareChallenge(html) {
  if (!html) return false;
  return (
    html.includes('challenge-error-text') ||
    html.includes('Enable JavaScript and cookies to continue') ||
    html.includes('cf-challenge') ||
    html.includes('cf-browser-verification') ||
    html.includes('Just a moment...') ||
    html.includes('Checking your browser') ||
    html.includes('cf-mitigated')
  );
}

/**
 * Race a promise against a timeout.
 *
 * Note this does NOT cancel the underlying work: a timed-out Playwright scraper
 * keeps its browser alive, because the `finally { browser.close() }` inside it
 * never runs while the promise is still pending. Pass `onTimeout` to clean up.
 */
function withTimeout(promise, ms, label = 'operation', onTimeout) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    if (timedOut && typeof onTimeout === 'function') {
      try {
        onTimeout();
      } catch (err) {
        console.warn(`${label}: timeout cleanup failed: ${err.message}`);
      }
    }
  });
}

/**
 * Run `fn` over `items` in sequential batches of `batchSize`, concurrently
 * within each batch.
 *
 * `shouldStop` is an optional predicate checked before each batch. Without it a
 * long item list runs to completion regardless of how long that takes, which is
 * how a scraper blows past its own soft deadline and gets killed by the runner's
 * withTimeout — losing every result it had already gathered. Scrapers with a
 * deadline should pass one.
 */
async function fetchInBatches(items, batchSize, fn, batchDelayMs = 500, shouldStop) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (typeof shouldStop === 'function' && shouldStop(i, items.length)) break;
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item, idx) => fn(item, i + idx)));
    results.push(...batchResults);
    if (i + batchSize < items.length && batchDelayMs > 0) {
      await randomDelay(batchDelayMs, batchDelayMs * 2);
    }
  }
  return results;
}

async function launchStealthBrowser(opts = {}) {
  const browser = await playwright.chromium.launch({
    headless: opts.headless !== false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: new UserAgent().toString(),
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    ...opts.contextOptions,
  });
  return { browser, context };
}

/**
 * Warn loudly when a scraper's configured slices stop yielding.
 *
 * Both RealWorkFromAnywhere and CutShort shipped dead slices to production for
 * months (four 404ing RSS feeds and two listing paths returning empty shells,
 * found 2026-09-18) because a per-slice try/catch logged a warning that scrolled
 * past. An error line naming the board is what makes slice rot visible in CI.
 *
 * @param {string} source board name, for the log line
 * @param {Array<{slice: string, items: number}>} results one entry per slice
 */
function reportSliceHealth(source, results) {
  const empty = results.filter((r) => !r.items);
  if (!empty.length) return;

  const detail = empty.map((r) => r.slice).join(', ');
  const msg = `${source}: ${empty.length}/${results.length} slices returned nothing (${detail})`;

  // Half the slices dead means the configuration has drifted from the site,
  // not that the board is quiet.
  if (empty.length >= results.length / 2) console.error(`SLICE ROT — ${msg}`);
  else console.warn(msg);
}

module.exports = {
  reportSliceHealth,
  delay,
  randomDelay,
  isCloudflareChallenge,
  withTimeout,
  fetchInBatches,
  launchStealthBrowser,
};
