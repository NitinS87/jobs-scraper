const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
  stripHtml,
} = require('../lib/descriptionParser');
const { fetchInBatches, reportSliceHealth } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

// Hyriko aggregates roles from company career pages for the Indian, US and
// Canadian markets. Server-rendered listings (no browser needed) and a clean
// JSON-LD JobPosting on every detail page — same shape as the YCombinator
// scraper, which this follows.
//
// ⚠️ robots.txt allows everything except /api/ and /favorites. Detail and
// listing HTML is fair game; do NOT reach for their API even if one surfaces.
const BASE = 'https://hyriko.com';

// Verified live 2026-09-20. India is the default prefix; /us and /ca are the
// other markets. Jobs-per-page differs by path (12 on /jobs, 30 on the other
// two), and `?page=N` returns genuinely distinct results on all of them.
const LISTING_PATHS = [
  '/jobs',
  '/internships',
  '/remote-jobs',
  '/us/jobs',
  '/ca/jobs',
];

// ⚠️ THIS HOST WENT DARK ON 2026-09-22 and may still be down. It served real
// content earlier the same day (339 jobs ingested, fully categorised), then
// stopped accepting TCP connections on :443 entirely — from this machine, from
// GitHub Actions runners, and through a third-party proxy. DNS resolves to
// 222.167.207.56, a China Telecom address, which is not plausible for an Indian
// job board, so this looks like a DNS change or lapse rather than rate limiting.
// It was NOT us being blocked: huntyourtribe and echojobs answered normally from
// the same machine at the same moment.
//
// The scraper needs no changes for that — it degrades to [] and
// reportSliceHealth logs SLICE ROT. Check with:
//     node scripts/probe-slices.js hyriko
// or the "Probe Slices" workflow, which runs from GitHub's network.
//
// Pacing was relaxed anyway (the old defaults issued ~350 requests in a couple
// of minutes, which is impolite regardless of who is at fault).
const MAX_JOBS = Number(process.env.HYRIKO_MAX_JOBS) || 150;
const MAX_PAGES = Number(process.env.HYRIKO_MAX_PAGES) || 6;
const SOFT_DEADLINE_MS = Number(process.env.HYRIKO_DEADLINE_MS) || 3 * 60 * 1000;

const DETAIL_BATCH_SIZE = 3;
const DETAIL_BATCH_DELAY_MS = 1500;
const REQUEST_TIMEOUT = 30000;
const PAGE_DELAY_MS = 1000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const JOB_HREF = /href="(\/jobs\/[^"#?]+)"/g;

// The apply link lives in the Next.js RSC payload rather than as a plain
// anchor, so it is matched as an escaped string.
//
// ⚠️ Do NOT take the job id from the RSC payload. It carries several \"jobId\"
// values (save-button and related-jobs widgets) and the first match is not this
// job's — using it gave every posting the same external_job_id, which would
// have collapsed the whole board into a single row under the
// (external_source, external_job_id) dedup key. The URL slug is unique.
const RSC_APPLY = /\\"href\\":\\"(https?:\/\/[^"\\]+)\\",\\"target\\":\\"_blank\\"/g;

const SOCIAL_HOSTS = /(?:x\.com|twitter\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|play\.google\.com|apps\.apple\.com|googletagmanager\.com|google\.com)/i;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function extractJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item && item['@type'] === 'JobPosting') out.push(item);
      }
    } catch {
      // Ignore malformed blocks; the page carries several.
    }
  });
  return out;
}

function mapEmploymentType(t) {
  if (!t) return null;
  const s = Array.isArray(t) ? t[0] : t;
  const upper = String(s).toUpperCase().replace(/[\s-]/g, '_');
  if (upper.includes('FULL')) return 'FULL_TIME';
  if (upper.includes('PART')) return 'PART_TIME';
  if (upper.includes('INTERN')) return 'INTERNSHIP';
  if (upper.includes('CONTRACT') || upper.includes('TEMPORARY')) return 'CONTRACT';
  return upper || null;
}

function pickLocation(ld) {
  if (!ld.jobLocation) return { location: null, country: null };
  const locs = Array.isArray(ld.jobLocation) ? ld.jobLocation : [ld.jobLocation];
  const parts = [];
  let country = null;
  for (const loc of locs) {
    const addr = (loc && loc.address) || {};
    // addressLocality on this board is often already "City, Region, Country",
    // so naively joining all three yields "Bengaluru, Karnataka, India,
    // Karnataka, IN". Drop segments already present in what we have.
    const segs = [];
    for (const seg of [addr.addressLocality, addr.addressRegion, addr.addressCountry]) {
      if (!seg) continue;
      const val = String(seg).trim();
      const joined = segs.join(', ').toLowerCase();
      if (val && !joined.includes(val.toLowerCase())) segs.push(val);
    }
    if (segs.length) parts.push(segs.join(', '));
    if (!country && addr.addressCountry) {
      country = String(addr.addressCountry).toUpperCase().slice(0, 2);
    }
  }
  return { location: parts.join(' / ') || null, country };
}

function parseSalary(ld) {
  const bs = ld.baseSalary;
  if (!bs) return null;
  const value = bs.value || {};
  const min = value.minValue != null ? Number(value.minValue) : null;
  const max = value.maxValue != null ? Number(value.maxValue) : (value.value != null ? Number(value.value) : null);
  if (min == null && max == null) return null;
  // Placeholder ranges (1-1, or sub-1k "annual" figures) are not real salaries.
  if (min === 1 && max === 1) return null;
  if (min != null && min > 0 && min < 1000 && max != null && max < 1000) return null;
  return { min, max, currency: bs.currency || value.currency || null };
}

/** The real careers-page URL this listing points at, if present. */
function extractApplyUrl(html) {
  RSC_APPLY.lastIndex = 0;
  let m = RSC_APPLY.exec(html);
  while (m) {
    const url = m[1];
    if (!SOCIAL_HOSTS.test(url) && !url.includes('hyriko.com')) return url;
    m = RSC_APPLY.exec(html);
  }
  return null;
}

async function fetchListingPage(path, page) {
  const url = page > 1 ? `${BASE}${path}?page=${page}` : `${BASE}${path}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT,
    });
    const found = new Set();
    JOB_HREF.lastIndex = 0;
    let m = JOB_HREF.exec(data);
    while (m) {
      // /jobs itself and the country index pages are not job details.
      if (m[1] !== '/jobs' && m[1].split('/').length > 2) found.add(m[1]);
      m = JOB_HREF.exec(data);
    }
    return [...found];
  } catch (err) {
    console.warn(`Hyriko: listing fetch failed ${url}: ${err.message}`);
    return [];
  }
}

async function collectJobUrls(deadline) {
  const seen = new Set();
  const sliceHealth = [];

  for (const path of LISTING_PATHS) {
    if (seen.size >= MAX_JOBS || Date.now() > deadline) break;
    let addedForPath = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (seen.size >= MAX_JOBS || Date.now() > deadline) break;

      const urls = await fetchListingPage(path, page);
      if (!urls.length) break;

      let newOnPage = 0;
      for (const u of urls) {
        if (seen.size >= MAX_JOBS) break;
        if (!seen.has(u)) { seen.add(u); newOnPage += 1; }
      }
      addedForPath += newOnPage;
      // Paths overlap heavily (a remote Indian job appears on /jobs and
      // /remote-jobs), so a page of pure duplicates means we are done here.
      if (newOnPage === 0) break;
      await delay(PAGE_DELAY_MS);
    }

    sliceHealth.push({ slice: path, items: addedForPath });
    console.log(`Hyriko: ${path} → ${addedForPath} new job URLs`);
  }

  reportSliceHealth('Hyriko', sliceHealth);
  return [...seen];
}

async function fetchDetailPage(relPath) {
  const url = `${BASE}${relPath}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: REQUEST_TIMEOUT,
    });
    const $ = cheerio.load(data);
    const ld = extractJsonLd($)[0];
    if (!ld) return null;

    const title = (ld.title || '').trim();
    if (!title) return null;

    const descriptionHtml = ld.description || '';
    const descText = stripHtml(descriptionHtml);

    // Multi-vertical board across three countries — keep it to roles the
    // taxonomy can place, in English.
    if (!isProfessionalRole(title)) return null;
    if (!isLikelyEnglish(title, descText)) return null;

    const { location, country } = pickLocation(ld);
    const salary = parseSalary(ld);
    const parsed = parseDescription(descriptionHtml);

    const org = ld.hiringOrganization || {};
    const applyUrl = extractApplyUrl(data);

    const externalId = relPath.replace('/jobs/', '');

    const country_code = country || parseCountryCode(location || '') || null;
    const isRemote = /telecommute/i.test(String(ld.jobLocationType || ''))
      || /\bremote\b/i.test(location || '')
      || /\bremote\b/i.test(title);

    return {
      title,
      // Point at the employer's own posting when Hyriko exposes it — that is
      // the page a candidate actually applies on.
      source_url: applyUrl || url,
      description: descriptionHtml,
      posted_at: ld.datePosted ? new Date(ld.datePosted).toISOString() : null,
      external_job_id: `hyriko-${externalId}`,
      external_source: 'Hyriko',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: !!isRemote,
      location,
      country_code,
      job_type: mapEmploymentType(ld.employmentType) || parsed.job_type,
      experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
      salary_min: salary ? salary.min : null,
      salary_max: salary ? salary.max : null,
      salary_currency: salary ? salary.currency : null,
      skills: parsed.skills,
      requirements: parsed.requirements,
      responsibilities: parsed.responsibilities,
      benefits: parsed.benefits,
      summary: parsed.summary || descText.slice(0, 200),
      highlights: parsed.highlights,
      required_qualifications: parsed.required_qualifications,
      preferred_qualifications: parsed.preferred_qualifications,
      visa_sponsorship: parsed.visa_sponsorship,
      categories: ld.industry ? [ld.industry].flat().filter(Boolean) : [],
      company: {
        name: org.name || null,
        logo_url: org.logo || null,
        website: org.sameAs || org.url || null,
        country_code,
      },
    };
  } catch (err) {
    console.warn(`Hyriko: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeHyriko() {
  const deadline = Date.now() + SOFT_DEADLINE_MS;
  console.log(`Hyriko: collecting job URLs across ${LISTING_PATHS.length} listing paths...`);

  const urls = await collectJobUrls(deadline);
  console.log(`Hyriko: discovered ${urls.length} unique job URLs`);
  if (!urls.length) return [];

  const results = await fetchInBatches(
    urls,
    DETAIL_BATCH_SIZE,
    fetchDetailPage,
    DETAIL_BATCH_DELAY_MS,
    () => Date.now() > deadline,
  );
  const jobs = results.filter(Boolean);
  console.log(`Hyriko: extracted ${jobs.length} jobs (${urls.length - jobs.length} filtered or failed)`);
  return jobs;
}

module.exports = scrapeHyriko;
module.exports.LISTING_PATHS = LISTING_PATHS;
