const axios = require('axios');
const { parseDescription, parseExperienceLevelFromTitle } = require('../lib/descriptionParser');
const { delay } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');
const { createPagingGuard, getRecencyConfig, classifyDate } = require('../lib/recency');

// englishjobs.de aggregates English-language roles in Germany. It ships a
// /llms.txt that documents its own machine interface, so this scraper follows
// the site's published contract rather than scraping rendered HTML:
//
//  - Any page accepts ?format=markdown (alias format=md) and responds with
//    text/markdown. Links inside a Markdown response point at canonical HTML
//    URLs, so the parameter must be re-appended on every request.
//  - Pagination is ?page=N at 20 jobs/page (verified: page 1 and 2 share zero
//    jobs). ?pg= and /2 are silently ignored and return page 1.
//  - Location slugs come from llms.txt. We iterate the 16 federal STATES rather
//    than the ~90 cities: states tile the whole country with far less overlap.
//
// Two constraints shape the output:
//  - There are no detail pages for most listings. Each card links to
//    /clickout/<hash>, which 302s to an external ATS and is Disallow-ed in
//    robots.txt, so we never follow it. Everything is read off the card, which
//    means descriptions are a 1-3 sentence snippet rather than a full posting.
//  - The <hash> in the clickout URL is stable across fetches (verified by
//    re-fetching the same page), so it serves as the dedup key even though the
//    surrounding sig/e query params rotate.
//
// Dates render as "August 22" with no year, so parseYearlessDate infers it.
const BASE = 'https://englishjobs.de';

const MAX_JOBS = Number(process.env.ENGLISHJOBS_MAX_JOBS) || 500;
const PER_PAGE = 20;
const MAX_PAGES_PER_REGION = 25;
const REQUEST_TIMEOUT = 45000;
const SOFT_DEADLINE_MS = Number(process.env.ENGLISHJOBS_DEADLINE_MS) || 3.5 * 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'text/markdown,text/plain,*/*' };

// The 16 German federal states, from llms.txt "Allowed Locations".
const REGIONS = [
  'nordrhein-westfalen',
  'bayern',
  'baden-wuerttemberg',
  'hessen',
  'niedersachsen',
  'rheinland-pfalz',
  'berlin',
  'schleswig-holstein',
  'sachsen',
  'hamburg',
  'brandenburg',
  'sachsen-anhalt',
  'thueringen',
  'mecklenburg-vorpommern',
  'bremen',
  'saarland',
];

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Cards show "August 22" with no year. Assume the most recent occurrence: if
// treating it as the current year lands more than a couple of days in the
// future, it must belong to last year.
function parseYearlessDate(text) {
  if (!text) return null;
  const s = String(text).trim();

  const rel = s.match(/^(today|yesterday)$/i);
  if (rel) {
    const d = new Date();
    if (rel[1].toLowerCase() === 'yesterday') d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  const ago = s.match(/^(\d+)\s+days?\s+ago$/i);
  if (ago) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - Number(ago[1]));
    return d;
  }

  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month == null) return null;

  const now = new Date();
  let year = now.getUTCFullYear();
  let d = new Date(Date.UTC(year, month, Number(m[2])));
  if (d.getTime() > now.getTime() + 2 * 24 * 60 * 60 * 1000) {
    year -= 1;
    d = new Date(Date.UTC(year, month, Number(m[2])));
  }
  return d;
}

function markdownUrl(region, page) {
  const params = new URLSearchParams({ format: 'markdown', page: String(page) });
  return `${BASE}/in/${region}?${params.toString()}`;
}

// Cards look like:
//   [### Title](/clickout/<hash>?...)
//   * Company
//   * Location
//   * August 22
//   <optional ![Logo](url)>Snippet text
//   report probem
// The redirect path varies (/clickout/, /clickout_alt/, /clickredirect/,
// /subredirect/), and the title must not be allowed to run across a `]` — a
// greedy match swallowed the whole next link when a card used /clickout_alt/.
const CARD_RE =
  /\[###\s*([^\]]*?)\]\(\/(?:clickout_alt|clickout|clickredirect|subredirect)\/([0-9a-f]+)\?[^)]*\)/g;

function parseCards(markdown, region) {
  const cards = [];
  const matches = [...markdown.matchAll(CARD_RE)];

  matches.forEach((m, i) => {
    const title = m[1].replace(/\s+/g, ' ').replace(/\.\.\.$/, '').trim();
    const hash = m[2];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    const body = markdown.slice(start, end);

    const bullets = [...body.matchAll(/^\*\s+(.+?)\s*$/gm)].map((b) => b[1].trim());
    const company = bullets[0] || null;
    const location = bullets[1] || null;
    const dateText = bullets[2] || null;

    // Prose after the bullets, minus the inline logo image and the report link.
    let snippet = body
      .replace(/^\*\s+.+$/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/report\s+probem/gi, '')
      .replace(/\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (snippet.length > 2000) snippet = snippet.slice(0, 2000);

    const logoMatch = body.match(/!\[Logo\]\((https?:\/\/[^)]+)\)/i);

    cards.push({
      title,
      hash,
      company,
      location,
      dateText,
      snippet,
      logo: logoMatch ? logoMatch[1] : null,
      region,
    });
  });

  return cards;
}

function buildJob(card) {
  const posted = parseYearlessDate(card.dateText);
  const descriptionHtml = card.snippet ? `<p>${card.snippet}</p>` : '';
  const parsed = parseDescription(descriptionHtml);
  const location = card.location || 'Germany';

  return {
    title: card.title,
    // No per-job page exists for aggregated listings, and /clickout/* is
    // robots-disallowed, so point at the site's own search for this title.
    source_url: `${BASE}/jobs/${encodeURIComponent(card.title)}`,
    description: descriptionHtml,
    posted_at: posted ? posted.toISOString() : null,
    external_job_id: `englishjobs-${card.hash}`,
    external_source: 'EnglishJobs',
    source_type: 'SCRAPER',
    source_base_url: BASE,
    is_remote: /remote|home\s*office/i.test(`${card.title} ${card.snippet}`),
    location,
    country_code: 'DE',
    job_type: parsed.job_type || 'FULL_TIME',
    experience_level: parseExperienceLevelFromTitle(card.title) || parsed.experience_level,
    salary_min: parsed.salary ? parsed.salary.min : null,
    salary_max: parsed.salary ? parsed.salary.max : null,
    salary_currency: parsed.salary ? parsed.salary.currency : null,
    skills: parsed.skills,
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary: card.snippet ? card.snippet.slice(0, 200) : parsed.summary,
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship,
    categories: [],
    company: card.company
      ? { name: card.company, logo_url: card.logo, location, country_code: 'DE' }
      : null,
  };
}

async function scrapeEnglishJobs() {
  const cfg = getRecencyConfig('EnglishJobs');
  const deadline = Date.now() + SOFT_DEADLINE_MS;
  const seen = new Set();
  const jobs = [];
  let titleFiltered = 0;
  let staleDropped = 0;

  try {
    console.log(`EnglishJobs: crawling ${REGIONS.length} German states (window=${cfg.label})...`);

    for (const region of REGIONS) {
      if (jobs.length >= MAX_JOBS || Date.now() > deadline) break;

      // Cards are not reliably date-ordered within a region, so date evidence
      // never stops the crawl here — the guard still filters stale cards out,
      // but termination comes from maxPages / maxJobs / an empty page.
      const guard = createPagingGuard({
        source: 'EnglishJobs',
        tolerancePages: Infinity,
        maxPages: MAX_PAGES_PER_REGION,
        maxJobs: MAX_JOBS - jobs.length,
      });

      for (let page = 1; page <= MAX_PAGES_PER_REGION; page++) {
        if (jobs.length >= MAX_JOBS || Date.now() > deadline) break;

        let markdown;
        try {
          const res = await axios.get(markdownUrl(region, page), {
            headers: HEADERS,
            timeout: REQUEST_TIMEOUT,
            responseType: 'text',
          });
          markdown = typeof res.data === 'string' ? res.data : String(res.data);
        } catch (err) {
          console.warn(`EnglishJobs: ${region} page ${page} failed: ${err.message}`);
          break;
        }

        const cards = parseCards(markdown, region).filter((c) => {
          if (!c.title || seen.has(c.hash)) return false;
          return true;
        });

        const { items, stop, reason } = guard.observePage(cards, (c) => parseYearlessDate(c.dateText));
        staleDropped += cards.length - items.length;

        for (const card of items) {
          if (jobs.length >= MAX_JOBS) break;
          seen.add(card.hash);
          if (!isProfessionalRole(card.title) || !isLikelyEnglish(card.title, card.snippet)) {
            titleFiltered++;
            continue;
          }
          jobs.push(buildJob(card));
        }

        if (stop) {
          if (reason !== 'empty-page') console.log(guard.summary(reason));
          break;
        }
        if (cards.length === 0) break;
        await delay(400);
      }
    }

    console.log(
      `EnglishJobs: extracted ${jobs.length} jobs `
      + `(${titleFiltered} failed the role/English filter, ${staleDropped} outside the window)`
    );
    return jobs;
  } catch (err) {
    console.error('EnglishJobs: scrape failed:', err.message);
    return [];
  }
}

module.exports = scrapeEnglishJobs;
