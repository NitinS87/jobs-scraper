const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
  stripHtml,
} = require('../lib/descriptionParser');
const { launchStealthBrowser, delay } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

// EchoJobs aggregates software roles straight from company career pages. Its
// detail pages carry the richest JSON-LD of any source here — ~7k-character
// descriptions plus the employer's own website via hiringOrganization.sameAs.
//
// ⚠️ The site sits behind a Vercel Security Checkpoint. Plain axios/curl gets a
// 429 challenge page every time, so this drives a stealth browser. Measured
// 2026-09-20: the checkpoint resolves after roughly 12-45s on the FIRST
// navigation and then ~1-5s thereafter, because the clearance cookie lives on
// the browser context — so the whole run shares one context and pays that cost
// once.
//
// ⚠️ PAGINATION IS UNSOLVED, hence the small cap. `?page=N` renders nothing
// (verified 90s waits on pages 2 and 3), the list is not infinite-scroll (no
// growth across repeated scrolls), and the "Next →" control does not respond to
// locator.click() within 15s. Page one yields a reliable 20 links, and the board
// advertises hourly updates, so those slots churn and accumulate through the
// uploader's dedup across runs. If pagination is ever cracked, raise
// ECHOJOBS_MAX_JOBS — nothing else needs to change.
//
// Compliance: robots.txt allows `/` but disallows /api, /_next/data/, /auth,
// /settings, /unsub_job_alert and /_vercel/. This uses rendered HTML only.
// ⚠️ Do NOT reach for /_next/data/ — it is the obvious shortcut for a Next.js
// site and it is explicitly disallowed.
const BASE = 'https://echojobs.io';
const LISTING_URL = `${BASE}/jobs`;

const MAX_JOBS = Number(process.env.ECHOJOBS_MAX_JOBS) || 20;
const SOFT_DEADLINE_MS = Number(process.env.ECHOJOBS_DEADLINE_MS) || 6 * 60 * 1000;
// The site rate-limits hard — sustained probing earned a spell of blanket 429s.
const DETAIL_DELAY_MS = Number(process.env.ECHOJOBS_DELAY_MS) || 8000;

const CHECKPOINT_TIMEOUT_MS = 90000;
const NAV_TIMEOUT_MS = 45000;
const JOB_HREF = /href="(\/job\/[^"#?]+)"/g;

const isCheckpoint = (title) => /security checkpoint/i.test(title || '');

/**
 * Navigate and wait for the Vercel checkpoint to resolve.
 *
 * Waits on the page's own content rather than the title alone: the title flips
 * to the real one several seconds before the list renders, and returning early
 * yields a page with zero job links that looks like an empty board.
 *
 * @returns {Promise<{html: string, ok: boolean}>}
 */
async function gotoCleared(page, url, { needsLinks = false } = {}) {
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    console.warn(`EchoJobs: navigation failed for ${url}: ${err.message}`);
    return { html: '', ok: false };
  }

  while (Date.now() - started < CHECKPOINT_TIMEOUT_MS) {
    const title = await page.title().catch(() => '');
    if (!isCheckpoint(title)) {
      // The checkpoint clears by REDIRECTING, so this can land mid-navigation:
      // "page.content: Unable to retrieve content because the page is
      // navigating and changing the content". That threw out of the scraper and
      // killed the whole board (measured 2026-09-23 — EchoJobs returned 0 in CI
      // while working locally, because the runner is slower and hit the race
      // more often). A navigation in flight means "not ready yet", not "fatal".
      const html = await page.content().catch(() => null);
      if (html !== null) {
        if (!needsLinks) return { html, ok: true };
        JOB_HREF.lastIndex = 0;
        if (JOB_HREF.test(html)) return { html, ok: true };
      }
    }
    await page.waitForTimeout(3000);
  }

  console.warn(`EchoJobs: checkpoint did not clear for ${url} within ${CHECKPOINT_TIMEOUT_MS / 1000}s`);
  return { html: await page.content().catch(() => ''), ok: false };
}

function extractJsonLdJob(html) {
  const blocks = html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g);
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && item['@type'] === 'JobPosting') return item;
    }
  }
  return null;
}

function mapEmploymentType(t) {
  if (!t) return null;
  const upper = String(Array.isArray(t) ? t[0] : t).toUpperCase().replace(/[\s-]/g, '_');
  if (upper.includes('FULL')) return 'FULL_TIME';
  if (upper.includes('PART')) return 'PART_TIME';
  if (upper.includes('INTERN')) return 'INTERNSHIP';
  if (upper.includes('CONTRACT') || upper.includes('TEMPORARY')) return 'CONTRACT';
  return upper || null;
}

function pickLocation(ld) {
  if (!ld.jobLocation) return { location: null, country: null };
  const locs = Array.isArray(ld.jobLocation) ? ld.jobLocation : [ld.jobLocation];
  const parts = [];
  let country = null;
  for (const loc of locs) {
    const addr = (loc && loc.address) || {};
    // addressCountry is deliberately excluded from the DISPLAY string too, not
    // just from country resolution — it produced "Berlin, United States".
    const segs = [];
    for (const seg of [addr.addressLocality, addr.addressRegion]) {
      if (!seg) continue;
      const val = String(seg).trim();
      if (val && !segs.join(', ').toLowerCase().includes(val.toLowerCase())) segs.push(val);
    }
    if (segs.length) parts.push(segs.join(', '));

    // ⚠️ addressCountry is NOT trustworthy on this board: it reads "United
    // States" even for plainly foreign roles — verified 2026-09-21 on
    // "Bedford, Bedfordshire, GB" and a Kirchheim posting from a German GmbH,
    // both stamped United States. The locality/region string usually carries
    // the real ISO code, so resolve from that first and only fall back to
    // addressCountry when it yields nothing.
    if (!country) {
      const fromLocality = parseCountryCode([addr.addressLocality, addr.addressRegion].filter(Boolean).join(', '));
      if (fromLocality) country = fromLocality;
    }
  }

  if (!country) {
    const addr = (locs[0] && locs[0].address) || {};
    if (addr.addressCountry) country = parseCountryCode(String(addr.addressCountry));
  }
  return { location: parts.join(' / ') || null, country };
}

function parseSalary(ld) {
  const bs = ld.baseSalary;
  if (!bs) return null;
  const value = bs.value || {};
  const min = value.minValue != null ? Number(value.minValue) : null;
  const max = value.maxValue != null ? Number(value.maxValue) : (value.value != null ? Number(value.value) : null);
  if (min == null && max == null) return null;
  if (min === 1 && max === 1) return null;
  return { min, max, currency: bs.currency || value.currency || 'USD' };
}

function buildJob(relPath, html) {
  const ld = extractJsonLdJob(html);
  if (!ld) return null;

  const title = String(ld.title || '').trim();
  if (!title) return null;

  const descriptionHtml = ld.description || '';
  const descText = stripHtml(descriptionHtml);

  if (!isProfessionalRole(title)) return null;
  if (!isLikelyEnglish(title, descText)) return null;

  const { location, country } = pickLocation(ld);
  const salary = parseSalary(ld);
  const parsed = parseDescription(descriptionHtml);
  const org = ld.hiringOrganization || {};
  const country_code = country || parseCountryCode(location || '') || null;

  return {
    title,
    source_url: `${BASE}${relPath}`,
    description: descriptionHtml,
    posted_at: ld.datePosted ? new Date(ld.datePosted).toISOString() : null,
    // The trailing slug segment is unique per posting.
    external_job_id: `echojobs-${relPath.replace('/job/', '')}`,
    external_source: 'EchoJobs',
    source_type: 'SCRAPER',
    source_base_url: BASE,
    is_remote: /telecommute/i.test(String(ld.jobLocationType || ''))
      || /\bremote\b/i.test(location || '')
      || /\bremote\b/i.test(title),
    location,
    country_code,
    job_type: mapEmploymentType(ld.employmentType) || parsed.job_type || 'FULL_TIME',
    experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
    salary_min: salary ? salary.min : null,
    salary_max: salary ? salary.max : null,
    salary_currency: salary ? salary.currency : null,
    skills: parsed.skills,
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary: parsed.summary || descText.slice(0, 200),
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship,
    categories: ld.industry ? [ld.industry].flat().filter(Boolean) : [],
    company: {
      name: org.name || null,
      logo_url: org.logo || null,
      website: org.sameAs || null,
      country_code,
    },
  };
}

async function scrapeEchoJobs() {
  const deadline = Date.now() + SOFT_DEADLINE_MS;
  let browser;

  try {
    ({ browser } = await launchStealthBrowser());
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();

    console.log('EchoJobs: loading the listing (first navigation clears the checkpoint)...');
    const listing = await gotoCleared(page, LISTING_URL, { needsLinks: true });
    if (!listing.ok) {
      console.warn('EchoJobs: listing unavailable — returning no jobs');
      return [];
    }

    JOB_HREF.lastIndex = 0;
    const urls = [...new Set([...listing.html.matchAll(JOB_HREF)].map((m) => m[1]))].slice(0, MAX_JOBS);
    console.log(`EchoJobs: ${urls.length} job URLs from the listing`);
    if (!urls.length) return [];

    const jobs = [];
    for (let i = 0; i < urls.length; i += 1) {
      if (Date.now() > deadline) {
        console.warn(`EchoJobs: soft deadline reached after ${jobs.length}/${urls.length} detail pages`);
        break;
      }

      const detail = await gotoCleared(page, `${BASE}${urls[i]}`);
      if (detail.ok) {
        const job = buildJob(urls[i], detail.html);
        if (job) jobs.push(job);
      }

      if (i < urls.length - 1) await delay(DETAIL_DELAY_MS);
    }

    console.log(`EchoJobs: extracted ${jobs.length} jobs (${urls.length - jobs.length} filtered or failed)`);
    return jobs;
  } catch (err) {
    // A challenge or a hostile response must cost this board only, never the run.
    console.warn(`EchoJobs: scrape failed: ${err.message}`);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = scrapeEchoJobs;
