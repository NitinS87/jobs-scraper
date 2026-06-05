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

const BASE = 'https://www.gulftalent.com';
// Mobile site is server-rendered (the desktop /jobs/search is an AngularJS SPA).
const LISTING_URL = (page) => `${BASE}/mobile/search/jobs-in-_/all/${page}`;
const MAX_JOBS = Number(process.env.GULFTALENT_MAX_JOBS) || 500;
const MAX_LISTING_PAGES = 60; // 25 jobs/page; extra headroom for filtered-out roles
const DETAIL_BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 30000;

// GulfTalent blocks bare requests (403); full browser-like headers pass.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  Connection: 'keep-alive',
};

// Map the country segment in /mobile/<country>/jobs/... to an ISO code.
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

// /mobile/<country>/jobs/<slug>-<id>
const DETAIL_LINK_REGEX = /^\/mobile\/([a-z-]+)\/jobs\/([a-z0-9-]+)-(\d{4,})$/i;

function extractJsonLd($) {
  const postings = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const graph = item['@graph'] ? item['@graph'] : [item];
        for (const node of graph) {
          if (node && node['@type'] === 'JobPosting') postings.push(node);
        }
      }
    } catch {}
  });
  return postings;
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
  const segs = [addr.streetAddress, addr.addressLocality, addr.addressCountry]
    .filter(Boolean)
    .map((s) => String(s).trim());
  // De-dup repeated segments (GulfTalent often repeats "UAE")
  return [...new Set(segs)].join(', ') || null;
}

// Collect candidate { url, title } across listing pages until enough pass the filter.
async function collectCandidates() {
  const seen = new Set();
  const candidates = [];
  for (let page = 1; page <= MAX_LISTING_PAGES && candidates.length < MAX_JOBS; page++) {
    let data;
    try {
      const res = await axios.get(LISTING_URL(page), { headers: HEADERS, timeout: REQUEST_TIMEOUT });
      data = res.data;
    } catch (err) {
      console.warn(`GulfTalent: listing page ${page} failed: ${err.message}`);
      break;
    }
    const $ = cheerio.load(data);
    let foundOnPage = 0;
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').split('?')[0].split('#')[0];
      const m = href.match(DETAIL_LINK_REGEX);
      if (!m) return;
      const id = m[3];
      if (seen.has(id)) return;
      foundOnPage++;
      const title = $(el).text().replace(/\s+/g, ' ').trim();
      // Title-level role + language filter before spending a detail request.
      if (title && (!isProfessionalRole(title) || !isLikelyEnglish(title))) return;
      seen.add(id);
      candidates.push({ url: `${BASE}${href}`, country: m[1].toLowerCase(), id });
    });
    if (foundOnPage === 0) break; // no more results
  }
  return candidates.slice(0, MAX_JOBS);
}

async function fetchDetailPage(candidate) {
  const { url, country, id } = candidate;
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
    const $ = cheerio.load(data);
    const ld = extractJsonLd($)[0];
    if (!ld) return null;

    const title = (ld.title || $('h1').first().text() || '').trim();
    if (!title) return null;
    if (!isProfessionalRole(title)) return null;

    const descriptionHtml = ld.description || '';
    if (!isLikelyEnglish(title, stripHtml(descriptionHtml))) return null;

    const location = buildLocation(ld);
    const country_code = URL_COUNTRY_MAP[country] || parseCountryCode(location || '') || null;
    const parsed = parseDescription(descriptionHtml);
    const summary = parsed.summary || stripHtml(descriptionHtml).slice(0, 200);

    const org = ld.hiringOrganization || {};
    // GulfTalent sets sameAs to the org name (not a URL) — ignore it as a website.
    const companyWebsite = typeof org.url === 'string' && /^https?:\/\//.test(org.url) ? org.url : null;

    const categories = ld.industry ? [String(ld.industry).replace(/&amp;/g, '&')] : [];

    return {
      title,
      source_url: url,
      description: descriptionHtml,
      posted_at: ld.datePosted ? new Date(ld.datePosted).toISOString() : null,
      external_job_id: `gulftalent-${id}`,
      external_source: 'GulfTalent',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: /remote/i.test(location || '') || /remote/i.test(title),
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
      summary,
      highlights: parsed.highlights,
      required_qualifications: parsed.required_qualifications,
      preferred_qualifications: parsed.preferred_qualifications,
      visa_sponsorship: parsed.visa_sponsorship,
      categories,
      company: {
        name: org.name || null,
        logo_url: typeof org.logo === 'string' ? org.logo : org.logo?.url || null,
        website: companyWebsite,
        country_code,
      },
    };
  } catch (err) {
    console.warn(`GulfTalent: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeGulfTalent() {
  console.log('GulfTalent: collecting listing candidates...');
  const candidates = await collectCandidates();
  console.log(`GulfTalent: ${candidates.length} candidate jobs passed the title filter`);
  if (candidates.length === 0) return [];

  const results = await fetchInBatches(candidates, DETAIL_BATCH_SIZE, fetchDetailPage, 600);
  const jobs = results.filter(Boolean);
  console.log(`GulfTalent: extracted ${jobs.length} jobs (${candidates.length - jobs.length} dropped/failed)`);
  return jobs;
}

module.exports = scrapeGulfTalent;
