const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
  parseCountryCode,
} = require('../lib/descriptionParser');
const { fetchInBatches } = require('../lib/scraperUtils');

const BASE = 'https://www.ycombinator.com';
const LISTING_URLS = [
  `${BASE}/jobs`,
  `${BASE}/jobs/role/engineering`,
  `${BASE}/jobs/role/designer`,
  `${BASE}/jobs/role/operations`,
  `${BASE}/jobs/role/sales`,
  `${BASE}/jobs/role/product-manager`,
  `${BASE}/jobs/role/marketing`,
  `${BASE}/jobs/role/data-science`,
];
const DETAIL_BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 30000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const JOB_LINK_REGEX = /^\/companies\/([^/]+)\/jobs\/([^/?#]+)/;

async function fetchListingUrls() {
  const allLinks = new Set();
  for (const url of LISTING_URLS) {
    try {
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: REQUEST_TIMEOUT,
      });
      const $ = cheerio.load(data);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const m = href.match(JOB_LINK_REGEX);
        if (m) allLinks.add(`${BASE}${href.split('?')[0].split('#')[0]}`);
      });
    } catch (err) {
      console.warn(`YC: failed to fetch listing ${url}: ${err.message}`);
    }
  }
  return Array.from(allLinks);
}

function extractJsonLd($) {
  const postings = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const graph = item['@graph'] ? item['@graph'] : [item];
        for (const node of graph) {
          if (node['@type'] === 'JobPosting') postings.push(node);
        }
      }
    } catch {}
  });
  return postings;
}

function mapEmploymentType(t) {
  if (!t) return null;
  const v = String(Array.isArray(t) ? t[0] : t).toUpperCase().replace(/\s+/g, '_').replace(/-/g, '_');
  if (v.includes('FULL_TIME') || v === 'FULLTIME') return 'FULL_TIME';
  if (v.includes('PART_TIME') || v === 'PARTTIME') return 'PART_TIME';
  if (v.includes('CONTRACT')) return 'CONTRACT';
  if (v.includes('INTERN')) return 'INTERNSHIP';
  if (v.includes('TEMPORARY') || v.includes('FREELANCE')) return 'FREELANCE';
  return null;
}

function pickLocation(job) {
  if (!job.jobLocation) return { location: null, country: null };
  const locs = Array.isArray(job.jobLocation) ? job.jobLocation : [job.jobLocation];
  const parts = [];
  let country = null;
  for (const loc of locs) {
    const addr = loc.address || {};
    const segs = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
    if (segs.length) parts.push(segs.join(', '));
    if (!country && addr.addressCountry) country = String(addr.addressCountry).toUpperCase().slice(0, 2);
  }
  return { location: parts.join(' / ') || null, country };
}

function parseSalary(jobLd, locationHint) {
  const bs = jobLd.baseSalary;
  if (!bs) return null;
  const value = bs.value || {};
  const minRaw = value.minValue ?? null;
  const maxRaw = value.maxValue ?? value.value ?? null;
  if (minRaw == null && maxRaw == null) return null;

  const min = minRaw != null ? Number(minRaw) : null;
  const max = maxRaw != null ? Number(maxRaw) : null;
  // Reject placeholder values like 1-1 or sub-1k that aren't real annual figures
  if ((min != null && min > 0 && min < 1000) && (max != null && max < 1000)) return null;
  if (min === 1 && max === 1) return null;

  let currency = bs.currency || value.currency;
  if (!currency) {
    // Heuristic: large numeric ranges (>500k) for India locations are INR, otherwise USD
    const looksLikeINR = /\b(IN|India|Bengaluru|Bangalore|Mumbai|Delhi|Hyderabad|Chennai|Pune|Gurgaon|Noida)\b/i.test(locationHint || '') && (max != null && max > 500000);
    currency = looksLikeINR ? 'INR' : 'USD';
  }
  return { min, max, currency };
}

async function fetchDetailPage(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT,
    });
    const $ = cheerio.load(data);
    const postings = extractJsonLd($);
    const ld = postings[0];
    if (!ld) return null;

    const title = ld.title || $('title').text().split('|')[0].trim();
    const descriptionHtml = ld.description || '';
    const { location, country } = pickLocation(ld);
    const salary = parseSalary(ld, location);
    const employmentType = mapEmploymentType(ld.employmentType);
    const remoteHint = (ld.jobLocationType || '').toString().toUpperCase();
    const isRemote = remoteHint.includes('TELECOMMUTE') || /remote/i.test(location || '') || /remote/i.test(title);

    // Extract YC batch from page text (e.g. "Pine Park Health (S18)")
    const pageText = $('body').text();
    const batchMatch = pageText.match(/\((YC\s+[WS]\d{2,4}|[WSF]\d{2,4})\)/i);
    const ycBatch = batchMatch ? batchMatch[1].toUpperCase().replace(/^YC\s+/, '') : null;

    const company = ld.hiringOrganization || {};
    const companyName = company.name || null;
    const companyLogo = company.logo || null;
    const companyWebsite = company.sameAs || company.url || null;

    const parsed = parseDescription(descriptionHtml);
    const summary = parsed.summary || stripHtml(descriptionHtml).slice(0, 200);

    // external_job_id: the YC job slug after /jobs/
    const m = url.match(/\/companies\/[^/]+\/jobs\/([^/?#]+)/);
    const jobSlug = m ? m[1] : null;
    const externalId = jobSlug ? `yc-${jobSlug}` : `yc-${Buffer.from(url).toString('base64').slice(0, 16)}`;

    const categories = ld.industry ? [ld.industry].flat().filter(Boolean) : [];
    if (ycBatch) categories.push(`YC ${ycBatch}`);

    const country_code = country || parseCountryCode(location || '') || null;

    return {
      title,
      source_url: url,
      description: descriptionHtml,
      posted_at: ld.datePosted ? new Date(ld.datePosted).toISOString() : null,
      external_job_id: externalId,
      external_source: 'YCombinator',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: !!isRemote,
      location,
      country_code,
      job_type: employmentType || parsed.job_type || 'FULL_TIME',
      experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
      salary_min: salary ? salary.min : null,
      salary_max: salary ? salary.max : null,
      salary_currency: salary ? salary.currency : null,
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
        name: companyName,
        logo_url: companyLogo,
        website: companyWebsite,
        country_code,
      },
    };
  } catch (err) {
    console.warn(`YC: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeYCombinator() {
  console.log('Fetching YC job listings...');
  const urls = await fetchListingUrls();
  console.log(`YC: discovered ${urls.length} unique job URLs`);
  if (urls.length === 0) return [];

  const results = await fetchInBatches(urls, DETAIL_BATCH_SIZE, fetchDetailPage, 500);
  const jobs = results.filter(Boolean);
  console.log(`YC: extracted ${jobs.length} jobs (${urls.length - jobs.length} failed)`);
  return jobs;
}

module.exports = scrapeYCombinator;
