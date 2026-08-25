const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
} = require('../lib/descriptionParser');
const { fetchInBatches, delay } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');
const { isWithinWindow, getRecencyConfig } = require('../lib/recency');

// JobbSafari (jobbsafari.se) is Sweden's largest aggregator — ~50,000 live ads.
// It is a Next.js pages-router SSR app, so the whole listing is embedded in the
// __NEXT_DATA__ script tag and no browser is needed.
//
// Notes:
//  - Listing: /lediga-jobb?page=N at 30/page. robots.txt explicitly allows
//    ?page=N but DISALLOWS /lediga-jobb with yrke=/ort=/kategori=/foretag=, and
//    any URL with 4+ query params — so this scraper must never add facets.
//  - `startDate` is the ad PUBLICATION date, not tillträdesdatum: every value
//    sits in the recent past while `endDate` (the application deadline) is in the
//    future. Verified against live payloads, and it matches the detail page's
//    JSON-LD datePosted. It is therefore safe for both posted_at and the window.
//  - ⚠️ Results are ordered by relevance/campaign, NOT by date. Verified: page 1
//    spans 2026-05-26..08-20, page 5 contains a 2025 ad, and page 300 is
//    entirely recent. Every sort parameter tried (sort=date, sort=newest,
//    sortering=datum, order=date) was ignored. So date evidence must NEVER stop
//    the crawl here — we filter per entry and let maxJobs/maxPages/the deadline
//    bound it instead.
//  - Yield is low by design: on a Swedish board only ~5% of listings pass the
//    recency + professional-role filters, and the Swedish-language gate on the
//    description cuts further. That is the cost of the English-only policy.
//  - Detail pages carry a clean JSON-LD JobPosting but NO addressCountry, so the
//    country is hardcoded to SE.
const BASE = 'https://jobbsafari.se';
const LISTING = (page) => `${BASE}/lediga-jobb?page=${page}`;

const MAX_JOBS = Number(process.env.JOBBSAFARI_MAX_JOBS) || 500;
const MAX_LISTING_PAGES = Number(process.env.JOBBSAFARI_MAX_PAGES) || 120;
const DETAIL_BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 45000;
const SOFT_DEADLINE_MS = Number(process.env.JOBBSAFARI_DEADLINE_MS) || 5.5 * 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
};

function extractNextData(html) {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').html();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJobPosting($) {
  let found = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      let data = JSON.parse($(el).html());
      if (data && data['script:ld+json']) data = data['script:ld+json'];
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && item['@type'] === 'JobPosting') {
          found = item;
          return;
        }
      }
    } catch {
      /* ignore malformed blocks */
    }
  });
  return found;
}

function mapEmploymentType(t) {
  if (!t) return null;
  const v = String(Array.isArray(t) ? t[0] : t).toUpperCase().replace(/[-\s]+/g, '_');
  if (v.includes('FULL_TIME')) return 'FULL_TIME';
  if (v.includes('PART_TIME')) return 'PART_TIME';
  if (v.includes('CONTRACT')) return 'CONTRACT';
  if (v.includes('INTERN')) return 'INTERNSHIP';
  if (v.includes('TEMPORARY') || v.includes('FREELANCE')) return 'FREELANCE';
  return null; // 'OTHER' is common here and carries no information
}

function locationOf(entry) {
  const names = (entry.locations || [])
    .map((l) => (l.area && l.area.name) || l.name)
    .filter(Boolean);
  return [...new Set(names)].join(', ') || 'Sweden';
}

async function collectCandidates(deadline) {
  const seen = new Map();
  let scanned = 0;
  let staleDropped = 0;
  let titleFiltered = 0;

  for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
    if (seen.size >= MAX_JOBS || Date.now() > deadline) break;

    let html;
    try {
      const res = await axios.get(LISTING(page), { headers: HEADERS, timeout: REQUEST_TIMEOUT });
      html = res.data;
    } catch (err) {
      console.warn(`JobbSafari: listing page ${page} failed: ${err.message}`);
      break;
    }

    const data = extractNextData(html);
    const results = (data && data.props && data.props.pageProps
      && data.props.pageProps.jobEntries && data.props.pageProps.jobEntries.results) || [];
    if (results.length === 0) break;

    for (const entry of results) {
      scanned++;
      const title = String(entry.title || '').trim();
      const id = entry.pk;
      if (!title || !id || seen.has(String(id))) continue;

      // Filter before spending a detail request: the window first (cheap and
      // reliable), then the role. Language is judged later from the description,
      // since Swedish ads frequently carry English titles.
      if (!isWithinWindow(entry.startDate, 'JobbSafari')) {
        staleDropped++;
        continue;
      }
      if (!isProfessionalRole(title)) {
        titleFiltered++;
        continue;
      }

      seen.set(String(id), {
        id: String(id),
        slug: entry.slug,
        title,
        startDate: entry.startDate,
        company: entry.company || null,
        logoUrl: entry.logoUrl || null,
        location: locationOf(entry),
        categories: [
          ...(entry.mainCategories || []),
          ...(entry.subcategories || []),
        ].map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean),
      });
      if (seen.size >= MAX_JOBS) break;
    }

    await delay(400);
  }

  return {
    candidates: [...seen.values()],
    scanned,
    staleDropped,
    titleFiltered,
  };
}

async function fetchDetail(candidate) {
  if (!candidate.slug) return null;
  const url = `${BASE}/jobb/${candidate.slug}`;
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
    const $ = cheerio.load(data);
    const ld = extractJobPosting($);
    if (!ld) return null;

    const title = String(ld.title || candidate.title).trim();
    if (!isProfessionalRole(title)) return null;

    const descriptionHtml = ld.description || '';
    const descText = stripHtml(descriptionHtml);
    // The real language gate.
    if (!isLikelyEnglish(title, descText)) return { __notEnglish: true };

    const parsed = parseDescription(descriptionHtml);
    const org = ld.hiringOrganization || {};
    const location = candidate.location;
    const posted = ld.datePosted || candidate.startDate;

    return {
      title,
      source_url: url,
      description: descriptionHtml,
      posted_at: posted ? new Date(posted).toISOString() : null,
      external_job_id: `jobbsafari-${candidate.id}`,
      external_source: 'JobbSafari',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: /remote|distans|hemifrån/i.test(`${title} ${descText}`),
      location,
      // Detail JSON-LD has no addressCountry and this is a Sweden-only board.
      country_code: 'SE',
      job_type: mapEmploymentType(ld.employmentType) || parsed.job_type || 'FULL_TIME',
      experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
      salary_min: parsed.salary ? parsed.salary.min : null,
      salary_max: parsed.salary ? parsed.salary.max : null,
      salary_currency: parsed.salary ? parsed.salary.currency : null,
      skills: parsed.skills,
      requirements: parsed.requirements,
      responsibilities: parsed.responsibilities,
      benefits: parsed.benefits,
      summary: parsed.summary || descText.slice(0, 200),
      highlights: parsed.highlights,
      required_qualifications: parsed.required_qualifications,
      preferred_qualifications: parsed.preferred_qualifications,
      visa_sponsorship: parsed.visa_sponsorship,
      categories: candidate.categories,
      company: (candidate.company && candidate.company.name) || org.name
        ? {
          name: (candidate.company && candidate.company.name) || org.name,
          logo_url: candidate.logoUrl || (candidate.company && candidate.company.logoUrl) || null,
          location,
          country_code: 'SE',
        }
        : null,
    };
  } catch (err) {
    console.warn(`JobbSafari: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeJobbSafari() {
  const cfg = getRecencyConfig('JobbSafari');
  const deadline = Date.now() + SOFT_DEADLINE_MS;

  try {
    console.log(`JobbSafari: scanning listings (window=${cfg.label})...`);
    const { candidates, scanned, staleDropped, titleFiltered } = await collectCandidates(deadline);
    console.log(
      `JobbSafari: scanned ${scanned} listings -> ${candidates.length} candidates `
      + `(${staleDropped} outside the window, ${titleFiltered} not professional roles)`
    );
    if (candidates.length === 0) return [];

    const results = await fetchInBatches(
      candidates, DETAIL_BATCH_SIZE, fetchDetail, 600,
      (done, total) => {
        if (Date.now() <= deadline) return false;
        console.warn(`JobbSafari: soft deadline reached after ${done} of ${total} detail fetches.`);
        return true;
      }
    );

    const jobs = [];
    let notEnglish = 0;
    let failed = 0;
    for (const r of results) {
      if (!r) { failed++; continue; }
      if (r.__notEnglish) { notEnglish++; continue; }
      jobs.push(r);
    }

    console.log(
      `JobbSafari: extracted ${jobs.length} jobs `
      + `(${notEnglish} not English, ${failed} failed/no JSON-LD)`
    );
    return jobs;
  } catch (err) {
    console.error('JobbSafari: scrape failed:', err.message);
    return [];
  }
}

module.exports = scrapeJobbSafari;
