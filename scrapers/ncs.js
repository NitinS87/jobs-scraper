const axios = require('axios');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
} = require('../lib/descriptionParser');
const { delay } = require('../lib/scraperUtils');

const BASE = 'https://betacloud.ncs.gov.in';
const SEARCH_ENDPOINT = `${BASE}/api/v1/job-posts/search`;
const PAGE_SIZE = 20;
const MAX_PAGES = 25; // 25 * 20 = 500 jobs per run
const REQUEST_TIMEOUT = 30000;
const PAGE_DELAY_MS = 400;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: `${BASE}/job-listing`,
};

const JOB_TYPE_MAP = {
  FULL_TIME: 'FULL_TIME',
  PART_TIME: 'PART_TIME',
  CONTRACT: 'CONTRACT',
  INTERNSHIP: 'INTERNSHIP',
  TEMPORARY: 'CONTRACT',
  FREELANCE: 'FREELANCE',
};

function mapJobType(t) {
  if (!t) return null;
  return JOB_TYPE_MAP[String(t).toUpperCase()] || null;
}

function extractLocation(raw) {
  const list = Array.isArray(raw.jobLocations) ? raw.jobLocations : [];
  if (list.length === 0 && raw.isJobAllIndiaOrRemote) return 'All India / Remote';
  const parts = list
    .map((l) => [l.city, l.cityName, l.district, l.state, l.stateName].filter(Boolean).join(', '))
    .filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

function buildJob(raw) {
  if (!raw || raw.id == null || !raw.jobTitle) return null;

  const description = String(raw.jobDescription || '').trim();
  const wrappedDescription = description.startsWith('<')
    ? description
    : `<p>${description.replace(/\n+/g, '</p><p>')}</p>`;
  const parsed = parseDescription(wrappedDescription);

  const skills = Array.isArray(raw.requiredSkills) && raw.requiredSkills.length
    ? raw.requiredSkills
    : parsed.skills;

  const location = extractLocation(raw);
  const isRemote = !!raw.isJobAllIndiaOrRemote || /remote|wfh/i.test(`${raw.jobTitle} ${location || ''}`);

  const categories = [];
  if (raw.functionalArea) categories.push(raw.functionalArea);
  if (raw.functionalState) categories.push(raw.functionalState);
  if (raw.category && raw.category !== 'Any') categories.push(raw.category);

  const summary = parsed.summary || stripHtml(wrappedDescription).slice(0, 200);

  let postedAt = null;
  if (raw.publishedAt) {
    const d = new Date(raw.publishedAt);
    if (!isNaN(d.getTime())) postedAt = d.toISOString();
  }

  let expLevel = parseExperienceLevelFromTitle(raw.jobTitle) || parsed.experience_level;
  if (!expLevel && raw.maxExperience != null) {
    if (raw.maxExperience <= 2) expLevel = 'ENTRY';
    else if (raw.minExperience >= 8) expLevel = 'EXECUTIVE';
    else if (raw.minExperience >= 5) expLevel = 'SENIOR';
    else expLevel = 'MID';
  }

  const minSal = raw.minSalary != null ? Number(raw.minSalary) : null;
  const maxSal = raw.maxSalary != null ? Number(raw.maxSalary) : null;

  return {
    title: String(raw.jobTitle),
    source_url: `${BASE}/job-detail/${raw.id}`,
    description: wrappedDescription,
    posted_at: postedAt,
    external_job_id: `ncs-${raw.id}`,
    external_source: 'NCS',
    source_type: 'API',
    source_base_url: BASE,
    is_remote: isRemote,
    location,
    country_code: 'IN',
    job_type: mapJobType(raw.jobType) || parsed.job_type || 'FULL_TIME',
    experience_level: expLevel,
    salary_min: !raw.hideSalaryRange && minSal && minSal > 0 ? minSal : null,
    salary_max: !raw.hideSalaryRange && maxSal && maxSal > 0 ? maxSal : null,
    salary_currency: !raw.hideSalaryRange && (minSal || maxSal) ? 'INR' : null,
    skills,
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary,
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: false,
    categories,
    company: raw.organizationName ? {
      name: String(raw.organizationName),
      country_code: 'IN',
    } : null,
  };
}

async function fetchPage(page) {
  try {
    const { data } = await axios.post(
      `${SEARCH_ENDPOINT}?page=${page}&size=${PAGE_SIZE}`,
      {},
      { headers: HEADERS, timeout: REQUEST_TIMEOUT },
    );
    if (!data || data.status !== 'SUCCESS') return null;
    return data.data?.content || [];
  } catch (err) {
    console.warn(`NCS: page ${page} fetch failed: ${err.message}`);
    return null;
  }
}

async function scrapeNCS() {
  console.log('Fetching NCS jobs via public API...');
  const allJobs = [];
  const seenIds = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const content = await fetchPage(page);
    if (content === null) break;
    if (content.length === 0) break;

    let added = 0;
    for (const raw of content) {
      const job = buildJob(raw);
      if (!job) continue;
      if (seenIds.has(job.external_job_id)) continue;
      seenIds.add(job.external_job_id);
      allJobs.push(job);
      added++;
    }
    if (added === 0) break;
    await delay(PAGE_DELAY_MS);
  }

  console.log(`NCS: extracted ${allJobs.length} jobs`);
  return allJobs;
}

module.exports = scrapeNCS;
