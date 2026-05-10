// Wellfound (formerly AngelList Talent) — Tier C scraper.
// Wellfound uses Cloudflare Turnstile + Datadome and is frequently blocked.
// This scraper opt-in via ENABLE_TIER_C_SCRAPERS=true and returns [] when
// challenged. Don't expect consistent results.

const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
  parseCountryCode,
} = require('../lib/descriptionParser');
const {
  launchStealthBrowser,
  delay,
  randomDelay,
  isCloudflareChallenge,
} = require('../lib/scraperUtils');

const BASE = 'https://wellfound.com';
const LISTING_URL = `${BASE}/jobs`;
const NAV_TIMEOUT = 45000;

function buildJobFromCard(card) {
  if (!card || !card.title) return null;
  const description = card.description || '';
  const wrappedDescription = description.startsWith('<') ? description : `<p>${description.replace(/\n+/g, '</p><p>')}</p>`;
  const parsed = parseDescription(wrappedDescription);
  const country = parseCountryCode(card.location || '') || null;

  return {
    title: card.title,
    source_url: card.url,
    description: wrappedDescription,
    posted_at: card.posted_at || null,
    external_job_id: `wf-${card.jobId || Buffer.from(card.url).toString('base64').slice(0, 16)}`,
    external_source: 'Wellfound',
    source_type: 'SCRAPER',
    source_base_url: BASE,
    is_remote: !!card.is_remote,
    location: card.location || null,
    country_code: country,
    job_type: parsed.job_type || 'FULL_TIME',
    experience_level: parseExperienceLevelFromTitle(card.title) || parsed.experience_level,
    salary_min: card.salary_min || (parsed.salary ? parsed.salary.min : null),
    salary_max: card.salary_max || (parsed.salary ? parsed.salary.max : null),
    salary_currency: card.salary_currency || (parsed.salary ? parsed.salary.currency : null),
    skills: parsed.skills,
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary: parsed.summary || stripHtml(wrappedDescription).slice(0, 200),
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship,
    categories: card.categories || [],
    company: card.company ? {
      name: card.company,
      logo_url: card.company_logo || null,
      country_code: country,
    } : null,
  };
}

async function scrapeWellfound() {
  if (process.env.ENABLE_TIER_C_SCRAPERS !== 'true') {
    console.log('Wellfound: skipped (set ENABLE_TIER_C_SCRAPERS=true to enable)');
    return [];
  }

  console.log('Wellfound: launching browser (Tier C — expects frequent blocks)...');
  const { browser, context } = await launchStealthBrowser({ headless: true });
  const page = await context.newPage();

  try {
    await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await randomDelay(2500, 5000);

    const html = await page.content();
    if (isCloudflareChallenge(html)) {
      console.warn('Wellfound: Cloudflare challenge detected — returning [].');
      await browser.close();
      return [];
    }

    // Empty body = bot protection holding pattern (no challenge keywords, no content)
    const bodyTextLen = await page.evaluate(() => (document.body?.innerText || '').length);
    if (bodyTextLen < 100) {
      console.warn(`Wellfound: page rendered with ${bodyTextLen} chars of body text — likely bot-blocked. Returning [].`);
      await browser.close();
      return [];
    }

    // Probe for any visible job links/cards. Wellfound's DOM changes often;
    // we extract whatever job-shaped anchors are present and skip silently
    // if the structure is unrecognized.
    const cards = await page.evaluate(() => {
      const results = [];
      const anchors = document.querySelectorAll('a[href*="/jobs/"]');
      const seen = new Set();
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/jobs\/(\d+)[-/]?([^/?#]*)/);
        if (!m) continue;
        const jobId = m[1];
        if (seen.has(jobId)) continue;
        seen.add(jobId);

        const card = a.closest('[data-test], li, article, div[class*="job"], div[class*="Job"]') || a;
        const text = (card.innerText || '').trim();
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

        const title = lines[0] || a.innerText.trim();
        const company = lines[1] || null;
        const remoteHint = /remote/i.test(text);
        const locationLine = lines.find((l) => /\b(remote|onsite|hybrid|·|,)\b/i.test(l)) || null;

        const salaryMatch = text.match(/\$?([\d,]+)\s*[Kk]?\s*[-–—]\s*\$?([\d,]+)\s*[Kk]?/);
        let salaryMin = null;
        let salaryMax = null;
        let salaryCurrency = null;
        if (salaryMatch) {
          let smin = parseFloat(salaryMatch[1].replace(/,/g, ''));
          let smax = parseFloat(salaryMatch[2].replace(/,/g, ''));
          if (/k/i.test(salaryMatch[0])) { smin *= 1000; smax *= 1000; }
          if (smin >= 10000 && smax >= smin) {
            salaryMin = smin;
            salaryMax = smax;
            salaryCurrency = 'USD';
          }
        }

        results.push({
          title,
          company,
          url: href.startsWith('http') ? href : `https://wellfound.com${href}`,
          jobId,
          location: locationLine,
          is_remote: remoteHint,
          salary_min: salaryMin,
          salary_max: salaryMax,
          salary_currency: salaryCurrency,
          description: text,
        });
      }
      return results;
    });

    console.log(`Wellfound: discovered ${cards.length} potential job cards.`);
    const jobs = cards.map(buildJobFromCard).filter(Boolean);
    console.log(`Wellfound: extracted ${jobs.length} jobs.`);
    return jobs;
  } catch (err) {
    console.warn(`Wellfound: scrape failed: ${err.message}`);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = scrapeWellfound;
