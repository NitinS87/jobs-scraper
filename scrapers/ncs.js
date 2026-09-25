const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
} = require('../lib/descriptionParser');
const { launchStealthBrowser } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

const BASE = 'https://ncs.gov.in';
const LISTING_URL = `${BASE}/job-listing`;

// ⚠ The old POST to www.ncs.gov.in/api/v1/job-posts/search is dead. The site was
// rebuilt as an Angular SPA on a new API host (api.ncs.gov.in) and, critically,
// BOTH the request body and the response are encrypted — content-type
// application/octet-stream going out, an opaque base64 blob coming back under a
// misleading application/json header. Verified 2026-09-22.
//
// The old endpoint now returns the SPA's HTML shell with HTTP 200, so the
// scraper's `data.status !== 'SUCCESS'` check returned null and the board
// reported "extracted 0 jobs" for months without ever erroring.
//
// The app decrypts and renders results itself, so the rendered DOM is the only
// workable surface. Results load by infinite scroll at 20 per batch; `?page=N`
// is ignored.
const MAX_JOBS = Number(process.env.NCS_MAX_JOBS) || 500;
const SOFT_DEADLINE_MS = Number(process.env.NCS_DEADLINE_MS) || 4 * 60 * 1000;
const SCROLL_BATCH = 20;
const SCROLL_SETTLE_MS = 2500;
const NAV_TIMEOUT = 45000;
const RENDER_WAIT_MS = 6000;

/**
 * Cards have no detail link, so everything comes off the card text. Observed
 * line order: title, locations, company, experience, a "What do you need..."
 * heading, the description snippet, employment type, functional area.
 */
function buildJob(card) {
  const title = (card.title || '').trim();
  if (!title) return null;
  if (!isProfessionalRole(title)) return null;

  const description = (card.description || '').trim();
  if (!isLikelyEnglish(title, description)) return null;

  const location = (card.location || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || null;
  const parsed = parseDescription(description);

  const categories = [card.functionalArea, ...(card.skills || [])].filter(Boolean);

  return {
    title,
    source_url: LISTING_URL,
    description,
    posted_at: null,
    external_job_id: `ncs-${card.id}`,
    external_source: 'NCS',
    source_type: 'SCRAPER',
    source_base_url: BASE,
    is_remote: /remote|work from home/i.test(title) || /remote/i.test(location || ''),
    location,
    // NCS is India's National Career Service — every listing is domestic.
    country_code: parseCountryCode(location || '') || 'IN',
    job_type: card.jobType || parsed.job_type,
    experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
    salary_min: parsed.salary ? parsed.salary.min : null,
    salary_max: parsed.salary ? parsed.salary.max : null,
    salary_currency: parsed.salary ? parsed.salary.currency : null,
    skills: (card.skills || []).length ? card.skills : parsed.skills,
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary: parsed.summary || description.slice(0, 200),
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship,
    categories: [...new Set(categories)],
    company: {
      name: card.company || null,
      country_code: 'IN',
    },
  };
}

/** Read every rendered card. */
function extractCards() {
  return [...document.querySelectorAll('.job-title')].map((titleEl, idx) => {
    const card = titleEl.closest('.card');
    if (!card) return null;
    const lines = card.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    const title = titleEl.innerText.trim();

    const typeIdx = lines.findIndex((l) => /^(FULL_TIME|PART_TIME|CONTRACT|INTERNSHIP)$/i.test(l));
    const headingIdx = lines.findIndex((l) => /^what do you need/i.test(l));

    // The location line is OPTIONAL, so fixed indices shift by one on cards
    // that omit it — company then reads as the experience string. Anchor on the
    // experience line instead, which is always present and unambiguous.
    const expIdx = lines.findIndex((l) => /\d+\s*years?\s*-\s*\d+\s*years?\s*experience/i.test(l));
    const company = expIdx > 0 ? lines[expIdx - 1] : '';
    // On a location-less card lines[expIdx - 2] IS the title, so guard against
    // writing the job title into the location field.
    const locLine = expIdx > 1 ? lines[expIdx - 2] : '';
    const location = locLine && locLine !== title ? locLine : '';

    return {
      // No per-job URL or id is exposed, so derive a stable key from the
      // content. Position alone would churn as the listing reorders.
      id: `${title}|${company}`.replace(/\s+/g, ' ').slice(0, 180),
      title,
      location,
      company,
      experience: expIdx >= 0 ? lines[expIdx] : '',
      description: headingIdx >= 0 ? (lines[headingIdx + 1] || '') : (lines[5] || ''),
      jobType: typeIdx >= 0 ? lines[typeIdx].toUpperCase() : null,
      functionalArea: typeIdx >= 0 ? (lines[typeIdx + 1] || null) : null,
      skills: typeIdx >= 0 ? lines.slice(typeIdx + 3).filter((l) => l.length < 60
        && !/applicant|ago|just now|N\/A/i.test(l)).slice(0, 6) : [],
      idx,
    };
  }).filter(Boolean);
}

async function scrapeNCS() {
  const deadline = Date.now() + SOFT_DEADLINE_MS;
  let browser;
  try {
    console.log('NCS: loading the job listing (rendered DOM — the API is encrypted)...');
    ({ browser } = await launchStealthBrowser());
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();

    await page.goto(LISTING_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(RENDER_WAIT_MS);

    let rendered = await page.evaluate(() => document.querySelectorAll('.job-title').length);
    if (rendered === 0) {
      console.warn('NCS: no job cards rendered — the listing markup may have changed again');
      return [];
    }

    const totalText = await page.evaluate(() => {
      const el = document.querySelector('.total-job-counts');
      return el ? el.innerText.trim() : null;
    });
    if (totalText) console.log(`NCS: ${totalText}`);

    // Infinite scroll: each pass appends SCROLL_BATCH more cards.
    let stalls = 0;
    while (rendered < MAX_JOBS && Date.now() < deadline && stalls < 3) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(SCROLL_SETTLE_MS);
      const next = await page.evaluate(() => document.querySelectorAll('.job-title').length);
      if (next <= rendered) stalls += 1; else stalls = 0;
      rendered = next;
    }
    if (Date.now() >= deadline) console.warn('NCS: soft deadline reached while scrolling');

    const cards = await page.evaluate(extractCards);
    console.log(`NCS: ${cards.length} cards rendered`);

    const seen = new Set();
    const jobs = [];
    for (const card of cards) {
      if (jobs.length >= MAX_JOBS) break;
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      const job = buildJob(card);
      if (job) jobs.push(job);
    }

    console.log(`NCS: extracted ${jobs.length} jobs (${cards.length - jobs.length} dropped by filters)`);
    return jobs;
  } catch (err) {
    console.warn(`NCS: run failed: ${err.message}`);
    return [];
  } finally {
    if (browser && typeof browser.close === 'function') await browser.close().catch(() => {});
  }
}

module.exports = scrapeNCS;
