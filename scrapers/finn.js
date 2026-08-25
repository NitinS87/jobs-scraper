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

// FINN.no is Norway's dominant classifieds site; /job/search is its job board.
//
// ⚠️ robots.txt STATUS — READ BEFORE CHANGING THIS FILE.
// finn.no/robots.txt opens with an explicit prohibition:
//   "# Notice: Crawling FINN.no is prohibited unless you have written permission."
// and repeats it in Norwegian, citing åndsverksloven. The /job/search and
// /job/ad/ paths are NOT in the Disallow list, but the blanket ban is stated and
// is echoed in FINN's terms. This scraper exists because the repo owner reviewed
// that and explicitly decided to proceed. It is deliberately rate-limited well
// below what the site would tolerate. If you are not the owner, do not enable it.
//
// Technical notes:
//  - /job/fulltime/search.html 301s to /job/search; use the canonical path.
//  - Pagination is ?page=N at ~51 ads/page, but page 51+ returns HTTP 500 — a
//    hard cap of 50 pages (~2,550 ads) per query, verified. Reaching more of the
//    ~14k corpus therefore requires slicing, and we slice by `occupation=0.NN`
//    rather than geography: it both spreads the load and targets the tech and
//    white-collar categories directly, so far fewer detail pages are wasted.
//  - ⚠️ FINN wraps its JSON-LD in an envelope: {"script:ld+json": {...}}. A
//    naive d['@type'] === 'JobPosting' check finds NOTHING. Unwrap first.
//  - Listing markup carries no publish date, so the recency window is applied at
//    the detail stage against JSON-LD datePosted.
//  - Titles are misleading for language detection: Norwegian tech ads are titled
//    "Senior Software Engineer". The description is the real English gate.
const BASE = 'https://www.finn.no';
const SEARCH = `${BASE}/job/search`;

const MAX_JOBS = Number(process.env.FINN_MAX_JOBS) || 500;
const MAX_PAGES_PER_SLICE = 50; // hard site limit: page 51 returns HTTP 500
const DETAIL_BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 45000;
const SOFT_DEADLINE_MS = Number(process.env.FINN_DEADLINE_MS) || 5.5 * 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.8',
};

// FINN occupation facets (verified live). Tech + white-collar only: the manual,
// retail, healthcare, hospitality and trades categories are left out, since
// isProfessionalRole would drop them anyway and fetching them wastes requests.
const OCCUPATIONS = [
  '0.23', // IT utvikling
  '0.22', // IT drift og vedlikehold
  '0.20', // Ingeniør
  '0.1',  // Analyse
  '0.25', // Konsulent
  '0.32', // Ledelse
  '0.47', // Produktledelse
  '0.48', // Prosjektledelse
  '0.7',  // Design
  '0.12', // Forretningsutvikling og strategi
  '0.34', // Markedsfører
  '0.53', // Salg
  '0.41', // HR, personal og rekruttering
  '0.24', // Jurist
  '0.13', // Forskning og stipendiat
  '0.30', // Kvalitetssikring
  '0.5',  // Brukerstøtte og support
  '0.2',  // Arkitekt og planlegging
  '0.51', // Rådgivning
  '0.50', // Revisjon og kontroll
];

const AD_URL_RE = /\/job\/ad\/(\d+)/;

// FINN wraps each JSON-LD block as {"script:ld+json": {...}}.
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
  return null;
}

function buildLocation(ld) {
  const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
  const addr = (loc && loc.address) || {};
  const segs = [addr.addressLocality, addr.addressRegion]
    .filter(Boolean)
    .map((s) => String(s).trim());
  const country = addr.addressCountry || 'NO';
  return {
    text: [...new Set(segs)].join(', ') || 'Norway',
    country: typeof country === 'string' ? country : (country.name || 'NO'),
  };
}

async function collectCandidates(deadline) {
  const seen = new Map();
  let titleFiltered = 0;

  for (const occupation of OCCUPATIONS) {
    if (seen.size >= MAX_JOBS || Date.now() > deadline) break;

    for (let page = 1; page <= MAX_PAGES_PER_SLICE; page++) {
      if (seen.size >= MAX_JOBS || Date.now() > deadline) break;

      let html;
      try {
        const res = await axios.get(`${SEARCH}?occupation=${occupation}&page=${page}`, {
          headers: HEADERS,
          timeout: REQUEST_TIMEOUT,
        });
        html = res.data;
      } catch (err) {
        // page > 50 legitimately 500s; anything else is worth a line in the log.
        if (!err.response || err.response.status !== 500) {
          console.warn(`FINN: ${occupation} page ${page} failed: ${err.message}`);
        }
        break;
      }

      const $ = cheerio.load(html);
      let foundOnPage = 0;

      $('a[href*="/job/ad/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(AD_URL_RE);
        if (!m) return;
        const id = m[1];
        if (seen.has(id)) return;
        foundOnPage++;

        const title = $(el).text().replace(/\s+/g, ' ').trim();
        // Cheap pre-filter. Language is decided later from the description,
        // because Norwegian ads routinely carry English titles.
        if (title && !isProfessionalRole(title)) {
          titleFiltered++;
          return;
        }
        seen.set(id, { id, title });
      });

      if (foundOnPage === 0) break;
      await delay(500);
    }
  }

  return { candidates: [...seen.values()].slice(0, MAX_JOBS), titleFiltered };
}

async function fetchDetail(candidate) {
  const url = `${BASE}/job/ad/${candidate.id}`;
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
    const $ = cheerio.load(data);
    const ld = extractJobPosting($);
    if (!ld || !ld.title) return null;

    const title = String(ld.title).trim();
    if (!isProfessionalRole(title)) return null;

    // Recency is applied here: the listing markup carries no publish date.
    if (!isWithinWindow(ld.datePosted, 'FINN')) return { __stale: true };

    const descriptionHtml = ld.description || '';
    const descText = stripHtml(descriptionHtml);
    // The real language gate — Norwegian ads often have English titles.
    if (!isLikelyEnglish(title, descText)) return { __notEnglish: true };

    const { text: location, country } = buildLocation(ld);
    const country_code = /^[A-Z]{2}$/.test(country) ? country : 'NO';
    const parsed = parseDescription(descriptionHtml);
    const org = ld.hiringOrganization || {};

    return {
      title,
      source_url: url,
      description: descriptionHtml,
      posted_at: ld.datePosted ? new Date(ld.datePosted).toISOString() : null,
      external_job_id: `finn-${candidate.id}`,
      external_source: 'FinnNo',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: /remote|hjemmekontor|fjernarbeid/i.test(`${title} ${descText}`),
      location,
      country_code,
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
      categories: [],
      company: org.name
        ? {
          name: org.name,
          website: typeof org.url === 'string' && /^https?:\/\//.test(org.url) ? org.url : null,
          location,
          country_code,
        }
        : null,
    };
  } catch (err) {
    console.warn(`FINN: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeFinn() {
  const cfg = getRecencyConfig('FINN');
  const deadline = Date.now() + SOFT_DEADLINE_MS;

  try {
    console.log(`FINN: collecting candidates across ${OCCUPATIONS.length} occupation slices (window=${cfg.label})...`);
    const { candidates, titleFiltered } = await collectCandidates(deadline);
    console.log(`FINN: ${candidates.length} candidates passed the title filter (${titleFiltered} dropped)`);
    if (candidates.length === 0) return [];

    const results = await fetchInBatches(
      candidates, DETAIL_BATCH_SIZE, fetchDetail, 700,
      (done, total) => {
        if (Date.now() <= deadline) return false;
        console.warn(`FINN: soft deadline reached after ${done} of ${total} detail fetches.`);
        return true;
      }
    );

    const jobs = [];
    let stale = 0;
    let notEnglish = 0;
    let failed = 0;
    for (const r of results) {
      if (!r) { failed++; continue; }
      if (r.__stale) { stale++; continue; }
      if (r.__notEnglish) { notEnglish++; continue; }
      jobs.push(r);
    }

    console.log(
      `FINN: extracted ${jobs.length} jobs `
      + `(${notEnglish} not English, ${stale} outside the window, ${failed} failed/no JSON-LD)`
    );
    return jobs;
  } catch (err) {
    console.error('FINN: scrape failed:', err.message);
    return [];
  }
}

module.exports = scrapeFinn;
