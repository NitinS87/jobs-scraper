const axios = require('axios');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
} = require('../lib/descriptionParser');
const { delay } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');
const { createPagingGuard, getRecencyConfig } = require('../lib/recency');

// JobStairs (jobstairs.de) is a Nuxt SSR shell whose markup renders "0 Jobs" —
// the listing is loaded client-side from milch & zucker's BeeSite "gjb" API,
// which is open and unauthenticated.
//
// Gotchas, all verified against the live API:
//  - Use GET with the payload in a `data=` query param. The POST form honours
//    SearchCriteria but SILENTLY IGNORES SearchParameters: it always returns 10
//    items regardless of FirstItem/CountItem, and serves one of two stale cached
//    bodies depending on which backend (X-Host: jslive01/03) answers.
//  - SearchCriteria are genuinely honoured: PublicationLanguage.Code 1 = German
//    (28,144), 2 = English (673), and a bogus criterion returns 0. We request
//    language 2 so the English-only policy is enforced server-side rather than
//    by heuristics — the title heuristic is useless here, since German tech ads
//    are titled "Senior DevOps Engineer (w/m/d)" and read as English.
//  - CriterionName 'ID' takes a list of IDs, which is what makes the two-phase
//    fetch below possible.
//  - Descriptions are heavy and only some responses are cached: a cold call took
//    38s, the same call warm took 2s, and one single job carried a 165 KB
//    description. So phase 1 asks for metadata only (fast, 500/page) and phase 2
//    pulls descriptions just for the jobs that survived filtering.
//  - The www.jobstairs.de detail pages are useless: ~44s to load and no JSON-LD.
//  - robots.txt on www.jobstairs.de disallows /api/, but this API is on the
//    separate host api.jobstairs.de, which serves no robots.txt.
const API = 'https://api.jobstairs.de/v6/gjb_search';
const BASE = 'https://www.jobstairs.de';

const MAX_JOBS = Number(process.env.JOBSTAIRS_MAX_JOBS) || 500;
const PER_PAGE = 500;
const MAX_PAGES = 20;
const DESC_BATCH_SIZE = 25;
const REQUEST_TIMEOUT = 90000; // cold responses genuinely take ~40s
// Descriptions dominate the runtime here (cold API responses take ~40s), and a
// candidate fetched without one is discarded and re-discovered next run. A
// measured run at a 3.5-min deadline threw away 146 of 246 candidates, so this
// gets the same 5.5 min as the other detail-fetching boards.
const SOFT_DEADLINE_MS = Number(process.env.JOBSTAIRS_DEADLINE_MS) || 5.5 * 60 * 1000;

const ENGLISH_LANGUAGE_CODE = '2';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

const LIST_FIELDS = [
  'ID',
  'PositionTitle',
  'OrganizationName',
  'PositionLocation.CityName',
  'PositionLocation.CountryCode',
  'PositionStartDateInitial',
  'PositionURI',
  'ApplyURI',
  'JobCategory.Name',
  'CareerLevel.Name',
  'PositionOfferingType.Name',
];

async function callApi(searchParameters, searchCriteria) {
  const payload = {
    LanguageCode: 'DE',
    SearchParameters: searchParameters,
    SearchCriteria: searchCriteria || [],
  };
  const url = `${API}?data=${encodeURIComponent(JSON.stringify(payload))}`;
  const { data } = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
  const result = data.SearchResult || {};
  return {
    total: result.SearchResultCountAll || 0,
    items: (result.SearchResultItems || []).map((i) => i.MatchedObjectDescriptor || i),
  };
}

function descriptionOf(descriptor) {
  const d = descriptor.PositionFormattedDescription;
  if (Array.isArray(d)) return d.map((x) => (x && x.Content) || '').join('');
  if (d && d.Content) return d.Content;
  return '';
}

function firstName(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const v = list[0];
  return (v && (v.Name || v.CityName)) || null;
}

// CareerLevel / PositionOfferingType come back as German labels.
function mapExperienceLevel(careerLevel) {
  const v = String(careerLevel || '').toLowerCase();
  if (!v) return null;
  if (v.includes('führungs') || v.includes('fuehrungs') || v.includes('executive')) return 'EXECUTIVE';
  if (v.includes('berufserfahren') || v.includes('professional') || v.includes('senior')) return 'SENIOR';
  if (v.includes('berufseinsteiger') || v.includes('absolvent') || v.includes('student')
    || v.includes('praktikant') || v.includes('schüler') || v.includes('entry')) return 'ENTRY';
  return null;
}

function mapJobType(offeringType) {
  const v = String(offeringType || '').toLowerCase();
  if (!v) return null;
  if (v.includes('praktikum') || v.includes('intern')) return 'INTERNSHIP';
  if (v.includes('werkstudent') || v.includes('teilzeit') || v.includes('part')) return 'PART_TIME';
  if (v.includes('befristet') && !v.includes('unbefristet')) return 'CONTRACT';
  if (v.includes('freelance') || v.includes('freiberuf')) return 'FREELANCE';
  return 'FULL_TIME';
}

async function collectCandidates(deadline) {
  const guard = createPagingGuard({
    source: 'JobStairs',
    maxJobs: MAX_JOBS,
    maxPages: MAX_PAGES,
    // The API sorts by PositionStartDateInitial DESC and that field really is the
    // publication date (page 1 is today, deeper pages step backwards), so date
    // evidence is trustworthy here and the default tolerance applies.
  });

  const candidates = [];
  let titleFiltered = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > deadline) break;

    let batch;
    try {
      batch = await callApi(
        {
          FirstItem: page * PER_PAGE + 1,
          CountItem: PER_PAGE,
          MatchedObjectDescriptor: LIST_FIELDS,
          Sort: [{ Criterion: 'PositionStartDateInitial', Direction: 'DESC' }],
        },
        [{ CriterionName: 'PublicationLanguage.Code', CriterionValue: [ENGLISH_LANGUAGE_CODE] }]
      );
    } catch (err) {
      console.warn(`JobStairs: listing page ${page + 1} failed: ${err.message}`);
      break;
    }

    const { items, stop, reason } = guard.observePage(batch.items, (d) => d.PositionStartDateInitial);

    for (const d of items) {
      const title = String(d.PositionTitle || '').trim();
      if (!title) continue;
      if (!isProfessionalRole(title)) {
        titleFiltered++;
        continue;
      }
      candidates.push(d);
    }

    if (stop) {
      console.log(guard.summary(reason));
      break;
    }
    if ((page + 1) * PER_PAGE >= batch.total) break;
    await delay(400);
  }

  return { candidates: candidates.slice(0, MAX_JOBS), titleFiltered };
}

// Phase 2: descriptions only for the jobs that survived, fetched by ID.
async function attachDescriptions(candidates, deadline) {
  const byId = new Map();

  for (let i = 0; i < candidates.length; i += DESC_BATCH_SIZE) {
    if (Date.now() > deadline) {
      console.warn(`JobStairs: soft deadline reached after ${i} of ${candidates.length} descriptions.`);
      break;
    }
    const batch = candidates.slice(i, i + DESC_BATCH_SIZE);
    const ids = batch.map((c) => String(c.ID));
    try {
      const res = await callApi(
        {
          FirstItem: 1,
          CountItem: ids.length,
          MatchedObjectDescriptor: ['ID', 'PositionFormattedDescription.Content'],
        },
        [{ CriterionName: 'ID', CriterionValue: ids }]
      );
      for (const d of res.items) byId.set(String(d.ID), descriptionOf(d));
    } catch (err) {
      console.warn(`JobStairs: description batch at ${i} failed: ${err.message}`);
    }
    await delay(500);
  }

  return byId;
}

function buildJob(d, descriptionHtml) {
  const title = String(d.PositionTitle || '').trim();
  const parsed = parseDescription(descriptionHtml);
  const city = firstName(d.PositionLocation);
  const loc = Array.isArray(d.PositionLocation) ? d.PositionLocation[0] : d.PositionLocation;
  const country_code = (loc && loc.CountryCode) || 'DE';
  const location = city ? `${city}, ${country_code}` : 'Germany';
  const careerLevel = firstName(d.CareerLevel);
  const offering = firstName(d.PositionOfferingType);
  const category = firstName(d.JobCategory);

  return {
    title,
    source_url: d.PositionURI || d.ApplyURI || null,
    description: descriptionHtml,
    posted_at: d.PositionStartDateInitial
      ? new Date(d.PositionStartDateInitial).toISOString()
      : null,
    external_job_id: `jobstairs-${d.ID}`,
    external_source: 'JobStairs',
    source_type: 'API',
    source_base_url: BASE,
    is_remote: /remote|homeoffice|home office/i.test(`${title} ${descriptionHtml}`),
    location,
    country_code,
    job_type: mapJobType(offering) || parsed.job_type || 'FULL_TIME',
    experience_level: mapExperienceLevel(careerLevel)
      || parseExperienceLevelFromTitle(title)
      || parsed.experience_level,
    salary_min: parsed.salary ? parsed.salary.min : null,
    salary_max: parsed.salary ? parsed.salary.max : null,
    salary_currency: parsed.salary ? parsed.salary.currency : null,
    skills: parsed.skills,
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary: parsed.summary,
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship,
    categories: category ? [category] : [],
    // LogoURI comes back as a brand slug (e.g. ["deutschebahn"]), not a URL, so
    // we leave the logo to the uploader's favicon fallback rather than guessing.
    company: d.OrganizationName
      ? { name: d.OrganizationName, location, country_code }
      : null,
  };
}

async function scrapeJobStairs() {
  const cfg = getRecencyConfig('JobStairs');
  const deadline = Date.now() + SOFT_DEADLINE_MS;

  try {
    console.log(`JobStairs: collecting English-language listings (window=${cfg.label})...`);
    const { candidates, titleFiltered } = await collectCandidates(deadline);
    console.log(`JobStairs: ${candidates.length} candidates passed the title filter (${titleFiltered} dropped)`);
    if (candidates.length === 0) return [];

    const descriptions = await attachDescriptions(candidates, deadline);

    const jobs = [];
    let noDescription = 0;
    let notEnglish = 0;
    for (const d of candidates) {
      const html = descriptions.get(String(d.ID)) || '';
      if (!html) {
        noDescription++;
        continue;
      }
      const job = buildJob(d, html);
      // Server-side language filtering is the primary gate; this is a backstop.
      if (!isLikelyEnglish(job.title, parseDescription(html).summary)) {
        notEnglish++;
        continue;
      }
      jobs.push(job);
    }

    console.log(
      `JobStairs: extracted ${jobs.length} jobs `
      + `(${noDescription} without description, ${notEnglish} failed the English backstop)`
    );
    return jobs;
  } catch (err) {
    console.error('JobStairs: scrape failed:', err.message);
    return [];
  }
}

module.exports = scrapeJobStairs;
