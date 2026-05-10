// SimplyHired India — Tier C scraper.
// Cloudflare anti-bot in front. Opt-in via ENABLE_TIER_C_SCRAPERS=true.
// Returns [] when challenged.

const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
  parseCountryCode,
} = require('../lib/descriptionParser');
const {
  launchStealthBrowser,
  randomDelay,
  isCloudflareChallenge,
} = require('../lib/scraperUtils');

const BASE = 'https://www.simplyhired.co.in';
const LISTING_URL = `${BASE}/search?l=India`;
const NAV_TIMEOUT = 45000;
const MAX_PAGES = 5;

function parseJobKey(href) {
  const m = href.match(/[?&]jobkey=([^&#]+)/);
  return m ? m[1] : null;
}

function buildJobFromCard(card) {
  if (!card || !card.title || !card.url) return null;
  const description = card.description || '';
  const wrappedDescription = description.startsWith('<') ? description : `<p>${description.replace(/\n+/g, '</p><p>')}</p>`;
  const parsed = parseDescription(wrappedDescription);
  const country = parseCountryCode(card.location || '') || 'IN';

  return {
    title: card.title,
    source_url: card.url,
    description: wrappedDescription,
    posted_at: card.posted_at || null,
    external_job_id: `sh-${card.jobKey || Buffer.from(card.url).toString('base64').slice(0, 16)}`,
    external_source: 'SimplyHiredIN',
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
    categories: [],
    company: card.company ? { name: card.company, country_code: country } : null,
  };
}

async function scrapeSimplyHired() {
  if (process.env.ENABLE_TIER_C_SCRAPERS !== 'true') {
    console.log('SimplyHired: skipped (set ENABLE_TIER_C_SCRAPERS=true to enable)');
    return [];
  }

  console.log('SimplyHired: launching browser (Tier C — expects frequent blocks)...');
  const { browser, context } = await launchStealthBrowser({ headless: true });
  const page = await context.newPage();
  const allJobs = [];
  const seenKeys = new Set();

  try {
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = pageNum === 1 ? LISTING_URL : `${LISTING_URL}&pn=${pageNum}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      } catch (err) {
        console.warn(`SimplyHired: nav failed for ${url}: ${err.message}`);
        break;
      }
      await randomDelay(2500, 5000);

      const html = await page.content();
      if (isCloudflareChallenge(html)) {
        console.warn('SimplyHired: Cloudflare challenge detected — returning collected jobs.');
        break;
      }

      const bodyTextLen = await page.evaluate(() => (document.body?.innerText || '').length);
      if (bodyTextLen < 100) {
        console.warn(`SimplyHired: page ${pageNum} rendered with ${bodyTextLen} chars — likely bot-blocked.`);
        break;
      }

      const cards = await page.evaluate(() => {
        const results = [];
        const links = document.querySelectorAll('a[href*="jobkey="], a[href*="/job/"]');
        const seen = new Set();
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const keyMatch = href.match(/[?&]jobkey=([^&#]+)/) || href.match(/\/job\/([a-zA-Z0-9_-]+)/);
          if (!keyMatch) continue;
          const jobKey = keyMatch[1];
          if (seen.has(jobKey)) continue;
          seen.add(jobKey);

          const card = a.closest('[data-testid], li, article, div[class*="card"], div[class*="job"]') || a;
          const text = (card.innerText || '').trim();
          const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

          const title = a.innerText.trim() || lines[0];
          const company = lines.find((l) => /\b(pvt|ltd|inc|llp|company|technologies|systems|solutions)\b/i.test(l)) || lines[1] || null;
          const remoteHint = /remote|wfh/i.test(text);
          const locationLine = lines.find((l) => /(India|Bangalore|Bengaluru|Mumbai|Delhi|Hyderabad|Chennai|Pune|Gurgaon|Noida|Kolkata|Ahmedabad)/i.test(l)) || null;

          results.push({
            title,
            company,
            url: href.startsWith('http') ? href : `https://www.simplyhired.co.in${href}`,
            jobKey,
            location: locationLine,
            is_remote: remoteHint,
            description: text,
          });
        }
        return results;
      });

      let added = 0;
      for (const c of cards) {
        if (seenKeys.has(c.jobKey)) continue;
        seenKeys.add(c.jobKey);
        const job = buildJobFromCard(c);
        if (job) {
          allJobs.push(job);
          added++;
        }
      }
      console.log(`SimplyHired: page ${pageNum} -> ${added} new jobs (total ${allJobs.length})`);
      if (added === 0) break;
      await randomDelay(2000, 4000);
    }
  } finally {
    await browser.close();
  }

  console.log(`SimplyHired: extracted ${allJobs.length} jobs.`);
  return allJobs;
}

module.exports = scrapeSimplyHired;
