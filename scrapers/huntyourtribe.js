const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
  stripHtml,
} = require('../lib/descriptionParser');
const { fetchInBatches } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

// HuntYourTribe is an ATS product rather than a job board: /jobs aggregates the
// postings of its customer companies, so volume is bounded by how many
// companies use it (169 job URLs as of 2026-09-21), not by a market.
//
// ⚠️ THIS IS THE BRITTLE ONE. There is no JobPosting JSON-LD anywhere — the
// page carries only Organization, WebSite and SoftwareApplication — and the
// Next.js RSC payload stores description/company/skills as reference pointers
// ("$29", "$2b") that resolve into other chunks rather than as inline values.
// So the fields are read from the rendered DOM, which means a redesign or a
// Tailwind class change can break this scraper. It is built to degrade to an
// empty array rather than throw, and it is the lowest-value of the sources
// added in this batch; if it starts costing maintenance, delete it.
//
// Compliance: robots.txt allows everything with no Disallow, and there is no
// sitemap (404).
const BASE = 'https://huntyourtribe.com';
const LISTING_URL = `${BASE}/jobs`;

const MAX_JOBS = Number(process.env.HUNTYOURTRIBE_MAX_JOBS) || 150;
const SOFT_DEADLINE_MS = Number(process.env.HUNTYOURTRIBE_DEADLINE_MS) || 3 * 60 * 1000;

const DETAIL_BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 30000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Job details are /jobs/<company-slug>/<uuid>. /jobs/companies/<slug> pages are
// company profiles and must not be followed as jobs.
const JOB_PATH = /href="(\/jobs\/(?!companies\/)[^"/#?]+\/[0-9a-f-]{36})"/g;

// The listing renders relative dates only ("18 days ago"), which is all this
// board exposes. posted_at is excluded from the uploader's content hash, so a
// value that drifts by a day between runs does not cause rewrites.
const RELATIVE_AGE = /Posted\s+(?:about\s+)?(\d+)\s+(minute|hour|day|week|month)s?\s+ago/i;

const AGE_MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function parsePostedAt(text) {
  const m = text.match(RELATIVE_AGE);
  if (!m) return null;
  const ms = AGE_MS[m[2].toLowerCase()];
  if (!ms) return null;
  return new Date(Date.now() - Number(m[1]) * ms).toISOString();
}

function mapJobType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('intern')) return 'INTERNSHIP';
  if (s.includes('part')) return 'PART_TIME';
  if (s.includes('contract') || s.includes('temporary')) return 'CONTRACT';
  if (s.includes('full')) return 'FULL_TIME';
  return null;
}

/** Read a value from the Overview list, e.g. "Position Type" -> "Full Time". */
function overviewValue($, label) {
  let found = null;
  $('div,li,dt,span').each((_, el) => {
    if (found) return;
    const node = $(el);
    if (node.children().length > 2) return;
    if (node.text().trim().toLowerCase() !== label.toLowerCase()) return;
    const next = node.next();
    const val = next.text().trim();
    if (val && val.length < 60) found = val;
  });
  return found;
}

/**
 * Location is not in the DOM but IS inline in the RSC stream, unlike the
 * reference-pointer fields.
 */
function extractLocation(html) {
  const m = html.match(/\\"location\\":\\"([^"\\]{2,80})\\"/)
    || html.match(/"location"\s*:\s*"([^"]{2,80})"/);
  if (!m) return null;
  const val = m[1].trim();
  // "$30" and friends are RSC pointers, not values.
  if (!val || /^\$[0-9a-f]+$/i.test(val)) return null;
  return val;
}

async function fetchListingUrls() {
  try {
    const { data } = await axios.get(LISTING_URL, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT,
    });
    JOB_PATH.lastIndex = 0;
    return [...new Set([...data.matchAll(JOB_PATH)].map((m) => m[1]))];
  } catch (err) {
    console.warn(`HuntYourTribe: listing fetch failed: ${err.message}`);
    return [];
  }
}

async function fetchDetailPage(relPath) {
  const url = `${BASE}${relPath}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT,
    });
    const $ = cheerio.load(data);

    const title = $('h1').first().text().trim();
    if (!title) return null;

    // og:title is "<Title> at <Company>"; the company is whatever follows the
    // last " at ", which survives titles that themselves contain " at ".
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    let companyName = null;
    const atIdx = ogTitle.lastIndexOf(' at ');
    if (atIdx > 0) companyName = ogTitle.slice(atIdx + 4).trim() || null;
    if (!companyName) {
      // Fall back to the company slug in the URL.
      const slug = relPath.split('/')[2] || '';
      companyName = slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
    }

    if (!isProfessionalRole(title)) return null;

    // The Tailwind Typography container holds the whole posting body. If a
    // redesign removes it there is nothing else to fall back to, so bail rather
    // than store an empty description.
    const descriptionHtml = ($('div.prose').first().html() || '').trim();
    const descText = stripHtml(descriptionHtml);
    if (!isLikelyEnglish(title, descText)) return null;

    const pageText = $('body').text();
    const location = extractLocation(data);
    const parsed = parseDescription(descriptionHtml);
    const country_code = parseCountryCode(location || '') || null;

    const jobId = relPath.split('/').pop();

    return {
      title,
      source_url: url,
      description: descriptionHtml,
      posted_at: parsePostedAt(pageText),
      external_job_id: `huntyourtribe-${jobId}`,
      external_source: 'HuntYourTribe',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: /\bremote\b/i.test(location || '') || /\bremote\b/i.test(title),
      location,
      country_code,
      job_type: mapJobType(overviewValue($, 'Position Type')) || parsed.job_type,
      experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
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
      company: {
        name: companyName,
        logo_url: null,
        website: null,
        country_code,
      },
    };
  } catch (err) {
    console.warn(`HuntYourTribe: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeHuntYourTribe() {
  const deadline = Date.now() + SOFT_DEADLINE_MS;
  console.log('HuntYourTribe: fetching listing...');

  const urls = (await fetchListingUrls()).slice(0, MAX_JOBS);
  console.log(`HuntYourTribe: discovered ${urls.length} job URLs`);
  if (!urls.length) return [];

  const results = await fetchInBatches(
    urls,
    DETAIL_BATCH_SIZE,
    fetchDetailPage,
    400,
    () => Date.now() > deadline,
  );
  const jobs = results.filter(Boolean);

  // No JSON-LD here, so a redesign shows up as a total parse failure rather
  // than as subtly wrong fields. Say so loudly.
  if (urls.length >= 10 && jobs.length === 0) {
    console.error('SLICE ROT — HuntYourTribe: parsed 0 jobs from a non-empty listing; the DOM shape has probably changed');
  }

  console.log(`HuntYourTribe: extracted ${jobs.length} jobs (${urls.length - jobs.length} filtered or failed)`);
  return jobs;
}

module.exports = scrapeHuntYourTribe;
