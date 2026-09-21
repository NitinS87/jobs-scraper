const axios = require('axios');
const {
  parseExperienceLevelFromTitle,
  parseCountryCode,
  parseSalaryText,
} = require('../lib/descriptionParser');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

// GetSetHire is an India-focused board whose front end is a single-page app
// backed by one open, unauthenticated JSON endpoint. The whole corpus comes
// back in a single request, so there is no pagination and no detail fetch.
//
// ⚠️ THIS BOARD YIELDS THIN ROWS. Verified 2026-09-20: /jobs is the ONLY
// endpoint — /jobs/:id, /jobs/detail/:id, /job-details/:id and /companies all
// 404, and ?job_id= is ignored. The payload has exactly nine fields and none of
// them is a description or an apply URL. The SPA also has no per-job route
// (its bundle declares only "/"), so every row necessarily shares the same
// source_url. Rows therefore land with an empty description. If that proves
// unacceptable in the UI, this board is one registry line to remove.
//
// Compliance: www.getsethire.in/robots.txt allows all agents with no Disallow.
// api.getsethire.in serves Cloudflare's default content-signals preamble, which
// explains the signal vocabulary but declares NO signals and carries no
// User-agent/Disallow rules — by its own clause (c) that neither grants nor
// restricts. Nothing prohibits /jobs.
const BASE = 'https://www.getsethire.in';
const API = 'https://api.getsethire.in/jobs';

// Measured 2026-09-20: 515 jobs total. `limit` is the only honoured parameter —
// `page` and `offset` are ignored — and a limit above the corpus size simply
// returns everything, so one request is the entire board.
const MAX_JOBS = Number(process.env.GETSETHIRE_MAX_JOBS) || 1000;

const REQUEST_TIMEOUT = 30000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 444 of 515 rows carry one of these instead of a figure.
const NO_VALUE = /^(?:not\s*mentioned|none|na|n\/a|-|)$/i;

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return NO_VALUE.test(s) ? null : s;
};

function mapJobType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('intern')) return 'INTERNSHIP';
  if (s.includes('part')) return 'PART_TIME';
  if (s.includes('contract')) return 'CONTRACT';
  if (s.includes('full')) return 'FULL_TIME';
  return 'FULL_TIME';
}

/**
 * Salary strings here are free text written by whoever posted the role —
 * "12 LPA CTC", "25,000 Per month", "₹70L – ₹90L • Offers Equity". Hand the
 * shared parser what it understands and accept null for the rest.
 */
function parseCompensation(raw) {
  const text = clean(raw);
  if (!text) return null;
  const parsed = parseSalaryText(text);
  if (!parsed) return null;
  // Indian postings quote lakhs/CTC without a currency marker far more often
  // than not, and the board is India-only.
  return { ...parsed, currency: parsed.currency || 'INR' };
}

function buildJob(raw) {
  const title = clean(raw.role);
  if (!title) return null;

  // India-heavy multi-vertical board: keep it to roles the taxonomy can place.
  if (!isProfessionalRole(title)) return null;
  if (!isLikelyEnglish(title)) return null;

  const location = clean(raw.location);
  const salary = parseCompensation(raw.compensation);
  const postedAt = raw.createdAt ? new Date(raw.createdAt) : null;

  // job_id is a stable UUID and unique across the corpus (verified: 515/515).
  const externalId = clean(raw.job_id) || String(raw.id);
  if (!externalId) return null;

  return {
    title,
    // The SPA has no per-job route, so this is the only page that exists.
    source_url: BASE,
    description: '',
    posted_at: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt.toISOString() : null,
    external_job_id: `getsethire-${externalId}`,
    external_source: 'GetSetHire',
    source_type: 'SCRAPER',
    source_base_url: BASE,
    is_remote: /\bremote\b/i.test(location || '') || /\bremote\b/i.test(title),
    location,
    country_code: parseCountryCode(location || '') || (location ? 'IN' : null),
    job_type: mapJobType(raw.job_type),
    experience_level: parseExperienceLevelFromTitle(title),
    salary_min: salary ? salary.min : null,
    salary_max: salary ? salary.max : null,
    salary_currency: salary ? salary.currency : null,
    skills: [],
    requirements: [],
    responsibilities: [],
    benefits: [],
    summary: null,
    highlights: [],
    required_qualifications: [],
    preferred_qualifications: [],
    visa_sponsorship: null,
    categories: [],
    company: {
      name: clean(raw.company_name),
      logo_url: null,
      website: null,
      country_code: 'IN',
    },
  };
}

async function scrapeGetSetHire() {
  console.log('GetSetHire: fetching the full job list (single request)...');

  let rows;
  try {
    const { data } = await axios.get(API, {
      params: { limit: MAX_JOBS },
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`GetSetHire: fetch failed: ${err.message}`);
    return [];
  }

  if (!rows.length) {
    console.warn('GetSetHire: API returned no rows');
    return [];
  }

  const jobs = [];
  const seen = new Set();
  let filtered = 0;

  for (const raw of rows) {
    const job = buildJob(raw);
    if (!job) { filtered += 1; continue; }
    if (seen.has(job.external_job_id)) continue;
    seen.add(job.external_job_id);
    jobs.push(job);
  }

  console.log(`GetSetHire: ${rows.length} rows → ${jobs.length} jobs (${filtered} filtered out)`);
  return jobs;
}

module.exports = scrapeGetSetHire;
