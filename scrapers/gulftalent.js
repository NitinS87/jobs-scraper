const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
  stripHtml,
} = require('../lib/descriptionParser');
const { launchStealthBrowser, delay } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

const BASE = 'https://www.gulftalent.com';

// The mobile site this scraper used to parse is gone — /mobile/search/... now
// 301s to the desktop SPA, and bare requests get an Akamai "Access Denied"
// served as HTTP 200 with a 100 KB error body, which is why the board silently
// returned 0 jobs rather than erroring (found 2026-09-22).
//
// The SPA is backed by a clean JSON API. Verified 2026-09-22: 36,384 jobs
// available, `limit` up to at least 2000 per call, and `offset` paging that
// runs to the end. ⚠ `page` is accepted but SILENTLY IGNORED — every page
// returns the same first rows, so paginate with `offset` only.
// ⚠ `version=2` appears in the SPA's own request but returns HTTP 500 here —
// verified 2026-09-22 by bisecting the parameters. Do not re-add it.
const API_PATH = (limit, offset) => '/api/jobs/search'
  + '?config[results]=ENABLED&config[isDynamicSearchV2]=true'
  + `&include_scraped=1&search_order=d&limit=${limit}&offset=${offset}`;

const SEARCH_URL = `${BASE}/jobs/search`;
const MAX_JOBS = Number(process.env.GULFTALENT_MAX_JOBS) || 500;
const API_PAGE_SIZE = Number(process.env.GULFTALENT_PAGE_SIZE) || 200;
const MAX_API_PAGES = 200;
const DETAIL_CONCURRENCY = Number(process.env.GULFTALENT_DETAIL_CONCURRENCY) || 3;
const SOFT_DEADLINE_MS = Number(process.env.GULFTALENT_DEADLINE_MS) || 5 * 60 * 1000;
const NAV_TIMEOUT = 30000;

// location_parts.iso_code is authoritative; this only backs it up.
const URL_COUNTRY_MAP = {
  uae: 'AE',
  'saudi-arabia': 'SA',
  qatar: 'QA',
  oman: 'OM',
  kuwait: 'KW',
  bahrain: 'BH',
  egypt: 'EG',
  jordan: 'JO',
  lebanon: 'LB',
  india: 'IN',
};

function mapEmploymentType(t) {
  if (!t) return null;
  const v = String(Array.isArray(t) ? t[0] : t).toUpperCase().replace(/[-\s]+/g, '_');
  if (v.includes('FULL_TIME')) return 'FULL_TIME';
  if (v.includes('PART_TIME')) return 'PART_TIME';
  if (v.includes('CONTRACT')) return 'CONTRACT';
  if (v.includes('INTERN')) return 'INTERNSHIP';
  if (v.includes('TEMPORARY') || v.includes('FREELANCE')) return 'FREELANCE';
  return null;
}

function buildLocation(ld) {
  const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
  const addr = (loc && loc.address) || {};
  const segs = [addr.streetAddress, addr.addressLocality, addr.addressCountry]
    .filter(Boolean)
    .map((s) => String(s).trim());
  // De-dup repeated segments (GulfTalent often repeats "UAE")
  return [...new Set(segs)].join(', ') || null;
}

// Collect candidate { url, title } across listing pages until enough pass the filter.
/**
 * Page the JSON API from page context. Cross-origin axios is Akamai-blocked, so
 * the fetch must be same-origin from a real browser page.
 */
async function collectCandidates(page, deadline) {
  const candidates = [];
  const seen = new Set();
  let titleFiltered = 0;
  let total = null;

  for (let i = 0; i < MAX_API_PAGES; i += 1) {
    if (candidates.length >= MAX_JOBS || Date.now() > deadline) break;
    const offset = i * API_PAGE_SIZE;

    const payload = await page.evaluate(async (path) => {
      try {
        const res = await fetch(path, { headers: { Accept: 'application/json' } });
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { __error: `non-JSON (${res.status})` }; }
      } catch (err) { return { __error: err.message }; }
    }, API_PATH(API_PAGE_SIZE, offset));

    if (!payload || payload.__error) {
      console.warn(`GulfTalent: API offset ${offset} failed: ${payload && payload.__error}`);
      break;
    }

    const positions = payload.positions || [];
    if (total === null) {
      total = payload.total_results;
      console.log(`GulfTalent: API reports ${total} jobs available`);
    }
    if (positions.length === 0) break;

    for (const p of positions) {
      if (candidates.length >= MAX_JOBS) break;
      if (!p || !p.id || seen.has(p.id)) continue;
      seen.add(p.id);

      const title = String(p.title || '').trim();
      if (!title || !isProfessionalRole(title)) { titleFiltered += 1; continue; }

      candidates.push({
        id: p.id,
        title,
        url: p.link ? `${BASE}${p.link}` : null,
        location: p.location || null,
        country_code: (p.location_parts && p.location_parts.iso_code)
          || URL_COUNTRY_MAP[p.location_parts && p.location_parts.country_slug]
          || null,
        company_name: p.company_confidential ? null : (p.company_name || null),
        company_logo: typeof p.listing_logo === 'string' && !/logo-is-confidential/.test(p.listing_logo)
          ? p.listing_logo : null,
        posted_at: p.posted_date ? new Date(p.posted_date).toISOString() : null,
        category: (p.job_category && p.job_category.cat_name_medium) || null,
        industry: p.industry_name_standard || null,
        salary_min: p.minSalary || null,
      });
    }

    if (positions.length < API_PAGE_SIZE) break;
    await delay(300);
  }

  console.log(
    `GulfTalent: ${candidates.length} candidates kept, ${titleFiltered} dropped by the title filter`,
  );
  return candidates;
}

/** Detail pages carry a JSON-LD JobPosting with the description. */
async function fetchDetailPage(page, candidate) {
  if (!candidate.url) return null;
  try {
    await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    const ld = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((el) => { try { return JSON.parse(el.textContent); } catch { return null; } })
        .filter(Boolean)
        .flat();
      return blocks.find((d) => d && d['@type'] === 'JobPosting') || null;
    });
    if (!ld) return null;

    const title = (ld.title || candidate.title || '').trim();
    if (!title || !isProfessionalRole(title)) return null;

    const descriptionHtml = ld.description || '';
    if (!isLikelyEnglish(title, stripHtml(descriptionHtml))) return null;

    const location = candidate.location || buildLocation(ld);
    const country_code = candidate.country_code || parseCountryCode(location || '') || null;
    const parsed = parseDescription(descriptionHtml);
    const summary = parsed.summary || stripHtml(descriptionHtml).slice(0, 200);

    const org = ld.hiringOrganization || {};
    // GulfTalent sets sameAs to the org name (not a URL) — ignore it as a website.
    const companyWebsite = typeof org.url === 'string' && /^https?:\/\//.test(org.url) ? org.url : null;

    const categories = [candidate.category, candidate.industry, ld.industry]
      .filter(Boolean)
      .map((c) => String(c).replace(/&amp;/g, '&'));

    return {
      title,
      source_url: candidate.url,
      description: descriptionHtml,
      posted_at: candidate.posted_at || (ld.datePosted ? new Date(ld.datePosted).toISOString() : null),
      external_job_id: `gulftalent-${candidate.id}`,
      external_source: 'GulfTalent',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: /remote/i.test(location || '') || /remote/i.test(title),
      location,
      country_code,
      job_type: mapEmploymentType(ld.employmentType) || parsed.job_type || 'FULL_TIME',
      experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
      salary_min: (parsed.salary ? parsed.salary.min : null) || candidate.salary_min,
      salary_max: parsed.salary ? parsed.salary.max : null,
      salary_currency: parsed.salary ? parsed.salary.currency : null,
      skills: parsed.skills,
      requirements: parsed.requirements,
      responsibilities: parsed.responsibilities,
      benefits: parsed.benefits,
      summary,
      highlights: parsed.highlights,
      required_qualifications: parsed.required_qualifications,
      preferred_qualifications: parsed.preferred_qualifications,
      visa_sponsorship: parsed.visa_sponsorship,
      categories: [...new Set(categories)],
      company: {
        name: org.name || candidate.company_name || null,
        logo_url: (typeof org.logo === 'string' ? org.logo : org.logo && org.logo.url) || candidate.company_logo || null,
        website: companyWebsite,
        country_code,
      },
    };
  } catch (err) {
    console.warn(`GulfTalent: detail fetch failed for ${candidate.url}: ${err.message}`);
    return null;
  }
}

async function scrapeGulfTalent() {
  const deadline = Date.now() + SOFT_DEADLINE_MS;
  let browser;
  try {
    ({ browser } = await launchStealthBrowser());
    const context = browser.contexts()[0] || await browser.newContext();
    const listingPage = await context.newPage();

    // Navigate once to establish the origin; the API is then same-origin.
    await listingPage.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await listingPage.waitForTimeout(1500);

    const candidates = await collectCandidates(listingPage, deadline);
    await listingPage.close();
    if (candidates.length === 0) return [];

    // A small pool of pages: one navigation per job, so serial is too slow.
    const pages = [];
    for (let i = 0; i < DETAIL_CONCURRENCY; i += 1) pages.push(await context.newPage());

    const jobs = [];
    for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
      if (Date.now() > deadline) {
        console.warn(`GulfTalent: soft deadline reached after ${jobs.length} detail pages`);
        break;
      }
      const batch = candidates.slice(i, i + DETAIL_CONCURRENCY);
      const settled = await Promise.all(batch.map((c, n) => fetchDetailPage(pages[n], c)));
      for (const job of settled) if (job) jobs.push(job);
      await delay(400);
    }

    console.log(`GulfTalent: extracted ${jobs.length} jobs from ${candidates.length} candidates`);
    return jobs;
  } catch (err) {
    console.warn(`GulfTalent: run failed: ${err.message}`);
    return [];
  } finally {
    if (browser && typeof browser.close === 'function') await browser.close().catch(() => {});
  }
}

module.exports = scrapeGulfTalent;
