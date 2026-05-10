const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
  parseCountryCode,
} = require('../lib/descriptionParser');
const { delay } = require('../lib/scraperUtils');

const BASE = 'https://cutshort.io';
const LISTING_PATHS = [
  '/jobs/startup-jobs',
  '/jobs/sales-jobs',
  '/jobs/marketing-jobs',
  '/jobs/product-jobs',
  '/jobs/design-jobs',
  '/jobs/finance-jobs',
];
const MAX_PAGES = 10;
const PAGE_DELAY_MS = 500;
const REQUEST_TIMEOUT = 30000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const ROLE_TYPE_MAP = {
  full_time: 'FULL_TIME',
  part_time: 'PART_TIME',
  contract: 'CONTRACT',
  internship: 'INTERNSHIP',
  freelance: 'FREELANCE',
};

function extractNextData(html) {
  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').html();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function findJobs(nextData) {
  const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
  for (const q of queries) {
    const data = q?.state?.data?.data?.pageData?.jobs;
    if (Array.isArray(data)) return data;
  }
  return [];
}

function mapRemote(remoteType) {
  if (!remoteType) return false;
  const t = String(remoteType).toLowerCase();
  if (t.includes('not_okay') || t === 'no_remote' || t === 'remote_no') return false;
  if (t.includes('remote') || t === 'wfh' || t.includes('work_from_home')) return true;
  return false;
}

function mapJobType(roleTypes) {
  if (!Array.isArray(roleTypes) || roleTypes.length === 0) return null;
  for (const rt of roleTypes) {
    const mapped = ROLE_TYPE_MAP[String(rt).toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function pickSalary(salaryRange) {
  if (!salaryRange) return null;
  const min = salaryRange.userMinVanity ?? salaryRange.minVanity ?? salaryRange.min;
  const max = salaryRange.userMaxVanity ?? salaryRange.maxVanity ?? salaryRange.max;
  const currency = salaryRange.currency || 'INR';
  if (!min && !max) return null;
  if (min === 0 && max === 0) return null;
  return { min: min || null, max: max || null, currency };
}

function buildJob(raw) {
  if (!raw || !raw._id || !raw.headline) return null;

  const description = raw.sanitizedComment || raw.comment || '';
  const parsed = parseDescription(description);
  const skills = Array.isArray(raw.allSkills) && raw.allSkills.length
    ? raw.allSkills
    : parsed.skills;
  const salary = pickSalary(raw.salaryRange);
  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  const locationStr = raw.locationsText || locations.join(', ') || null;
  const isRemote = mapRemote(raw.remoteType);
  const jobType = mapJobType(raw.roleTypes) || parsed.job_type || 'FULL_TIME';
  const expLevel = parseExperienceLevelFromTitle(raw.headline) || parsed.experience_level || (
    raw.expRange?.max != null ? (
      raw.expRange.max <= 2 ? 'ENTRY' :
      raw.expRange.min >= 8 ? 'EXECUTIVE' :
      raw.expRange.min >= 5 ? 'SENIOR' : 'MID'
    ) : null
  );

  const cd = raw.companyDetails || {};
  const company = cd.name ? {
    name: cd.name,
    logo_url: cd.logo || null,
    website: cd.links?.website || null,
    description: cd.sanitizedDescription || cd.description || null,
    country_code: 'IN',
  } : null;

  const country = parseCountryCode(locationStr) || 'IN';
  const summary = parsed.summary || stripHtml(description).slice(0, 200);

  return {
    title: raw.headline,
    source_url: raw.publicUrl || `${BASE}${raw.publicUrl?.startsWith('/') ? raw.publicUrl : ''}`,
    description,
    posted_at: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
    external_job_id: `cs-${raw._id}`,
    external_source: 'CutShort',
    source_type: 'SCRAPER',
    source_base_url: BASE,
    is_remote: isRemote,
    location: locationStr,
    country_code: country,
    job_type: jobType,
    experience_level: expLevel,
    salary_min: salary ? salary.min : null,
    salary_max: salary ? salary.max : null,
    salary_currency: salary ? salary.currency : null,
    skills,
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary,
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship,
    categories: [],
    company,
  };
}

async function fetchPage(path, page) {
  const url = page > 1 ? `${BASE}${path}?page=${page}` : `${BASE}${path}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT,
    });
    const next = extractNextData(data);
    if (!next) return [];
    return findJobs(next);
  } catch (err) {
    console.warn(`CutShort: page fetch failed ${url}: ${err.message}`);
    return [];
  }
}

async function scrapeCutShort() {
  console.log('Fetching CutShort listings...');
  const seenIds = new Set();
  const allJobs = [];

  for (const path of LISTING_PATHS) {
    let pageJobsCount = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rawJobs = await fetchPage(path, page);
      if (rawJobs.length === 0) break;

      let newOnPage = 0;
      for (const raw of rawJobs) {
        if (!raw._id || seenIds.has(raw._id)) continue;
        seenIds.add(raw._id);
        const job = buildJob(raw);
        if (job) {
          allJobs.push(job);
          newOnPage++;
        }
      }
      pageJobsCount += newOnPage;
      if (newOnPage === 0) break;
      if (page < MAX_PAGES) await delay(PAGE_DELAY_MS);
    }
    console.log(`CutShort: ${path} → ${pageJobsCount} new jobs`);
  }

  console.log(`CutShort: extracted ${allJobs.length} unique jobs`);
  return allJobs;
}

module.exports = scrapeCutShort;
