const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
} = require('../lib/descriptionParser');
const { launchStealthBrowser, delay } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');
const { recencyApiDays, getRecencyConfig } = require('../lib/recency');

// Teal (tealhq.com) exposes an unauthenticated JSON:API behind its job portal at
// resume-public.service.tealhq.com/public (found as VITE_JOB_SEARCH_API_URL in
// the portal bundle; the sibling api.job-search.tealhq.com 404s on these paths).
//
// Why Playwright and not axios, despite this being a plain JSON API:
//   Cloudflare fingerprints the TLS ClientHello, not just the headers. `curl
//   --http1.1` gets 200 while `curl --http2` gets 403, but *every* axios request
//   gets 403 no matter which headers are sent (UA, Origin, Referer, Sec-Fetch-*,
//   Accept-Encoding were all tried) because Node's TLS fingerprint is rejected
//   outright. A real Chrome gets through, so we drive one.
//
// We navigate ONCE to the API origin and then issue same-origin relative fetches
// from page context. Fetching cross-origin from www.tealhq.com fails CORS
// ("Failed to fetch"), and navigating per request would be far slower.
//
// Other API notes:
//   - JSON:API shaped: { data: [{ id, type, attributes }], meta: { total } }.
//   - per_page caps at 100 (200 -> 403); meta.total caps at 10,000 per query, so
//     we slice by keyword for breadth. An empty query returns the whole
//     multi-vertical firehose (baristas, welders) which the title filter drops.
//   - min_posted_at=<days> is a native recency filter, so this scraper takes the
//     window straight from lib/recency rather than using a paging guard.
//   - The listing has no description. Only the detail endpoint carries `body`,
//     and it is PLAIN TEXT, so we promote it to paragraphs for parseDescription.
const API_ORIGIN = 'https://resume-public.service.tealhq.com';
const SITE = 'https://www.tealhq.com';

const MAX_JOBS = Number(process.env.TEAL_MAX_JOBS) || 500;
const PER_PAGE = 100;
const MAX_PAGES_PER_QUERY = 10;
const DETAIL_BATCH_SIZE = 5;
const PAGE_TIMEOUT = 60000;

// Finish before runScrapers' withTimeout fires, so our own `finally` still runs
// and the browser is closed rather than orphaned.
const SOFT_DEADLINE_MS = Number(process.env.TEAL_DEADLINE_MS) || 3.5 * 60 * 1000;

// Keyword slices, each capped at 10k by the API. Chosen to cover the tech and
// white-collar roles the platform targets rather than the whole board.
const QUERIES = [
  'software engineer',
  'developer',
  'data',
  'devops',
  'security engineer',
  'product manager',
  'designer',
  'marketing',
  'sales',
  'finance',
  'analyst',
  'operations',
  'human resources',
  'customer success',
];

function mapEmploymentType(list) {
  const v = String((Array.isArray(list) ? list[0] : list) || '')
    .toUpperCase()
    .replace(/[-\s]+/g, '_');
  if (v.includes('FULL_TIME')) return 'FULL_TIME';
  if (v.includes('PART_TIME')) return 'PART_TIME';
  if (v.includes('CONTRACT')) return 'CONTRACT';
  if (v.includes('INTERN')) return 'INTERNSHIP';
  if (v.includes('TEMPORARY') || v.includes('FREELANCE')) return 'FREELANCE';
  return null;
}

function mapCareerLevel(levels) {
  const set = (levels || []).map((l) => String(l).toLowerCase());
  if (set.some((l) => l.includes('executive') || l.includes('director') || l.includes('vp'))) {
    return 'EXECUTIVE';
  }
  if (set.some((l) => l.includes('senior') || l.includes('lead') || l.includes('principal'))) {
    return 'SENIOR';
  }
  if (set.some((l) => l.includes('mid'))) return 'MID';
  if (set.some((l) => l.includes('entry') || l.includes('intern') || l.includes('junior'))) {
    return 'ENTRY';
  }
  return null;
}

// `body` arrives as plain text; parseDescription runs cheerio over HTML.
function textToHtml(text) {
  if (!text) return '';
  return String(text)
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// Same-origin fetch from page context — inherits Chrome's TLS fingerprint.
function fetchJson(page, path) {
  return page.evaluate(async (p) => {
    try {
      const r = await fetch(p, { headers: { Accept: 'application/json' } });
      if (!r.ok) return { __error: r.status };
      return await r.json();
    } catch (err) {
      return { __error: String(err && err.message) };
    }
  }, path);
}

function listingPath(query, pageNum, days) {
  const params = new URLSearchParams({
    order: 'date',
    page: String(pageNum),
    per_page: String(PER_PAGE),
  });
  if (query) params.set('query', query);
  if (days != null) params.set('min_posted_at', String(days));
  return `/public/job_posts?${params.toString()}`;
}

async function collectCandidates(page, deadline) {
  const days = recencyApiDays('Teal');
  const seen = new Map();
  let titleFiltered = 0;

  for (const query of QUERIES) {
    if (seen.size >= MAX_JOBS || Date.now() > deadline) break;

    for (let p = 1; p <= MAX_PAGES_PER_QUERY && seen.size < MAX_JOBS; p++) {
      if (Date.now() > deadline) break;

      const payload = await fetchJson(page, listingPath(query, p, days));
      if (payload.__error) {
        console.warn(`Teal: listing "${query}" page ${p} returned ${payload.__error}`);
        break;
      }

      const rows = payload.data || [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const attrs = row.attributes || {};
        const title = String(attrs.title || '').trim();
        if (!title || seen.has(row.id)) continue;
        // Filter on the title before spending a detail request on it.
        if (!isProfessionalRole(title) || !isLikelyEnglish(title)) {
          titleFiltered++;
          continue;
        }
        seen.set(row.id, { id: row.id, attrs });
        if (seen.size >= MAX_JOBS) break;
      }

      const total = (payload.meta && payload.meta.total) || 0;
      if (p * PER_PAGE >= total) break;
      await delay(250);
    }
  }

  return { candidates: [...seen.values()], titleFiltered };
}

function buildJob(id, listing, a) {
  const title = String(a.title || listing.title || '').trim();
  if (!title || !isProfessionalRole(title)) return null;

  const bodyText = a.body || a.job_description || '';
  if (!isLikelyEnglish(title, bodyText)) return null;

  const descriptionHtml = textToHtml(bodyText) || textToHtml(a.about_the_position);
  const parsed = parseDescription(descriptionHtml);

  const location = a.location || listing.location || null;
  const country_code = (a.country && /^[A-Z]{2}$/.test(a.country) ? a.country : null)
    || parseCountryCode(location || '')
    || 'US';

  const workplace = String(a.workplace_type || a.location_type || '').toLowerCase();
  const publicSlug = a.public_slug || listing.public_slug;

  // The API pre-structures these, so prefer them and fall back to the HTML
  // parser only where the API left a gap.
  const requirements = (a.requirements || []).filter(Boolean);
  const responsibilities = (a.responsibilities || []).filter(Boolean);
  const benefits = (a.benefits_description || []).filter(Boolean);
  const niceToHaves = (a.nice_to_haves || []).filter(Boolean);
  const skills = a.skills && typeof a.skills === 'object' && !Array.isArray(a.skills)
    ? Object.keys(a.skills)
    : (Array.isArray(a.skills) ? a.skills : []);

  const salaryMin = a.min_salary || a.base_salary_min_value || (parsed.salary ? parsed.salary.min : null);
  const salaryMax = a.max_salary || a.base_salary_max_value || (parsed.salary ? parsed.salary.max : null);

  return {
    title,
    source_url: publicSlug ? `${SITE}/job/${publicSlug}` : a.url || null,
    description: descriptionHtml,
    posted_at: a.posted_at ? new Date(a.posted_at).toISOString() : null,
    external_job_id: `teal-${id}`,
    external_source: 'Teal',
    source_type: 'API',
    source_base_url: SITE,
    is_remote: workplace.includes('remote') || /remote/i.test(title),
    location,
    country_code,
    job_type: mapEmploymentType(a.employment_type || a.job_type) || parsed.job_type || 'FULL_TIME',
    experience_level: mapCareerLevel(a.career_levels)
      || parseExperienceLevelFromTitle(title)
      || parsed.experience_level,
    salary_min: salaryMin,
    salary_max: salaryMax,
    // A currency with no amounts is noise, so only keep it alongside a figure.
    salary_currency: (salaryMin || salaryMax)
      ? (a.salary_currency || a.base_salary_currency_code
        || (parsed.salary ? parsed.salary.currency : null))
      : null,
    skills: skills.length ? skills : parsed.skills,
    requirements: requirements.length ? requirements : parsed.requirements,
    responsibilities: responsibilities.length ? responsibilities : parsed.responsibilities,
    benefits: benefits.length ? benefits : parsed.benefits,
    summary: a.about_the_position || parsed.summary || String(bodyText).slice(0, 200),
    highlights: parsed.highlights,
    required_qualifications: requirements.length ? requirements : parsed.required_qualifications,
    preferred_qualifications: niceToHaves.length ? niceToHaves : parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship,
    categories: [a.industry, a.job_function].filter(Boolean).map(String),
    company: {
      name: a.company_name || listing.company_name || null,
      logo_url: a.company_logo || listing.company_logo || null,
      location,
      industry: a.industry || null,
      country_code,
    },
  };
}

async function scrapeTeal() {
  const cfg = getRecencyConfig('Teal');
  const deadline = Date.now() + SOFT_DEADLINE_MS;
  const { browser, context } = await launchStealthBrowser();
  const page = await context.newPage();

  try {
    console.log(`Teal: collecting candidates across ${QUERIES.length} query slices (window=${cfg.label})...`);

    // Land on the API origin once; every later fetch is then same-origin.
    const resp = await page.goto(`${API_ORIGIN}/public/job_posts?page=1&per_page=1`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT,
    });
    if (!resp || resp.status() !== 200) {
      console.warn(`Teal: API origin returned ${resp ? resp.status() : 'no response'} — returning [].`);
      return [];
    }

    const { candidates, titleFiltered } = await collectCandidates(page, deadline);
    console.log(`Teal: ${candidates.length} candidates passed the title filter (${titleFiltered} dropped)`);
    if (candidates.length === 0) return [];

    // Detail fetches, batched inside page context so a batch is one round-trip.
    const jobs = [];
    let failed = 0;
    for (let i = 0; i < candidates.length; i += DETAIL_BATCH_SIZE) {
      if (Date.now() > deadline) {
        console.warn(`Teal: soft deadline reached after ${i} of ${candidates.length} detail fetches.`);
        break;
      }
      const batch = candidates.slice(i, i + DETAIL_BATCH_SIZE);
      const results = await page.evaluate(async (ids) => {
        return Promise.all(ids.map(async (id) => {
          try {
            const r = await fetch(`/public/job_posts/${id}`, { headers: { Accept: 'application/json' } });
            if (!r.ok) return null;
            const d = await r.json();
            return (d.data && d.data.attributes) || null;
          } catch {
            return null;
          }
        }));
      }, batch.map((c) => c.id));

      results.forEach((attrs, idx) => {
        if (!attrs) { failed++; return; }
        const job = buildJob(batch[idx].id, batch[idx].attrs, attrs);
        if (job) jobs.push(job);
      });
      await delay(400);
    }

    console.log(`Teal: extracted ${jobs.length} jobs (${candidates.length - jobs.length} dropped/failed, ${failed} fetch errors)`);
    return jobs;
  } catch (err) {
    console.error('Teal: scrape failed:', err.message);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = scrapeTeal;
