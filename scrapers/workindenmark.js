const {
  launchStealthBrowser,
  delay,
} = require('../lib/scraperUtils');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
} = require('../lib/descriptionParser');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

// Work in Denmark (workindenmark.jobnet.dk) is a Next.js app backed by a
// Duende BFF. The /bff/FindJob/Search endpoint returns full job records
// (title, hiringOrgName, full-HTML description, location, dates) but is gated
// by a session cookie plus the BFF anti-forgery header `X-CSRF: 1` (a plain
// request without it gets 401). We load the page with Playwright so the SPA
// establishes the session cookie, then page the JSON API from the page context
// with the X-CSRF header — far faster than visiting hundreds of detail pages.
const BASE = 'https://workindenmark.jobnet.dk';
const FIND_JOB_URL = `${BASE}/find-job`;
const SEARCH_PATH = (page, perPage) =>
  `/bff/FindJob/Search?resultsPerPage=${perPage}&pageNumber=${page}&orderType=BestMatch&kmRadius=50&searchString=`;

const MAX_JOBS = Number(process.env.WORKINDENMARK_MAX_JOBS) || 500;
const PER_PAGE = 100;
const PAGE_TIMEOUT = 60000;

async function scrapeWorkInDenmark() {
  const { browser, context } = await launchStealthBrowser();
  const page = await context.newPage();

  try {
    await page.goto(FIND_JOB_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    // Give the SPA a moment to complete the BFF login and set the session cookie.
    await delay(5000);

    // Page through the Search API from the page context (session cookie + X-CSRF).
    const ads = [];
    let total = Infinity;
    for (let pageNum = 1; ads.length < MAX_JOBS && (pageNum - 1) * PER_PAGE < total; pageNum++) {
      const result = await page.evaluate(
        async (path) => {
          const r = await fetch(path, { headers: { 'X-CSRF': '1', Accept: 'application/json' } });
          if (!r.ok) return { error: r.status };
          return await r.json();
        },
        SEARCH_PATH(pageNum, PER_PAGE)
      );
      if (result.error) {
        console.warn(`WorkInDenmark: Search page ${pageNum} returned ${result.error}`);
        break;
      }
      total = result.totalJobAdCount || total;
      const batch = result.jobAds || [];
      if (batch.length === 0) break;
      ads.push(...batch);
      await delay(400);
    }
    console.log(`WorkInDenmark: fetched ${ads.length} ads (total available ~${total})`);

    const jobs = [];
    for (const ad of ads) {
      if (jobs.length >= MAX_JOBS) break;
      const title = (ad.title || '').trim();
      if (!title || !isProfessionalRole(title)) continue;

      const descriptionHtml = ad.description || '';
      const descText = stripHtml(descriptionHtml);
      if (!isLikelyEnglish(title, descText)) continue;

      const jobAdId = ad.jobAdId;
      const isExternal = String(ad.isExternal) === 'true';
      const source_url =
        ad.jobAdUrl && /^https?:\/\//.test(ad.jobAdUrl)
          ? ad.jobAdUrl
          : `${BASE}/find-job/${jobAdId}`;

      const locParts = [ad.postalDistrictName || ad.municipality, ad.country]
        .filter(Boolean)
        .map((s) => String(s).trim());
      const location = [...new Set(locParts)].join(', ') || 'Denmark';

      const parsed = parseDescription(descriptionHtml);

      jobs.push({
        title,
        source_url,
        description: descriptionHtml,
        posted_at: ad.publicationDate ? new Date(ad.publicationDate).toISOString() : null,
        external_job_id: jobAdId,
        external_source: 'WorkInDenmark',
        source_type: 'SCRAPER',
        source_base_url: BASE,
        is_remote: /remote|hjemmearbejde|distancearbejde/i.test(descText) || /remote/i.test(title),
        location,
        country_code: 'DK',
        job_type: String(ad.workHourPartTime) === 'true' ? 'PART_TIME' : parsed.job_type || 'FULL_TIME',
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
        company: ad.hiringOrgName
          ? { name: ad.hiringOrgName, country_code: 'DK' }
          : null,
      });
    }

    console.log(`WorkInDenmark: extracted ${jobs.length} jobs after tech/English filters`);
    return jobs;
  } catch (err) {
    console.error('WorkInDenmark: scrape failed:', err.message);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = scrapeWorkInDenmark;
