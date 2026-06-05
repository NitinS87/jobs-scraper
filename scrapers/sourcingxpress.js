const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
  parseSalaryText,
  stripHtml,
} = require('../lib/descriptionParser');
const { fetchInBatches } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

// SourcingXpress is primarily a recruiter sourcing SaaS; its public job board
// (/search) exposes only a small set of live tech jobs, server-rendered with
// Next.js. There is no public pagination API, so we ingest what /search lists.
const BASE = 'https://www.sourcingxpress.com';
const SEARCH_URL = `${BASE}/search`;
const DETAIL_BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 30000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const JOB_LINK_REGEX = /^\/jobs\/([A-Za-z0-9]{8,})$/;

async function fetchListingIds() {
  const ids = new Set();
  try {
    const { data } = await axios.get(SEARCH_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      timeout: REQUEST_TIMEOUT,
    });
    const $ = cheerio.load(data);
    $('a[href]').each((_, el) => {
      const m = ($(el).attr('href') || '').split('?')[0].match(JOB_LINK_REGEX);
      if (m) ids.add(m[1]);
    });
  } catch (err) {
    console.warn(`SourcingXpress: listing fetch failed: ${err.message}`);
  }
  return [...ids];
}

// "Agent Engineer position at Volto consulting in Bangalore | SourcingXPress"
function parseOgTitle($) {
  const raw = ($('meta[property="og:title"]').attr('content') || $('title').text() || '')
    .replace(/\s*\|\s*SourcingXPress.*$/i, '')
    .trim();
  const m = raw.match(/^(.*?)\s+position at\s+(.*?)(?:\s+in\s+(.*))?$/i);
  if (m) return { title: m[1].trim(), company: m[2].trim(), location: (m[3] || '').trim() || null };
  return { title: raw || null, company: null, location: null };
}

// "₹ 10-50 Lacs PA" → INR 1,000,000–5,000,000 (1 lac = 100,000).
function parseIndianSalary(text) {
  if (!text) return null;
  const m = text.match(/₹?\s*([\d.]+)\s*[-–—to]+\s*([\d.]+)\s*(lacs?|lakhs?|cr|crores?)\b/i);
  if (!m) return null;
  const unit = m[3].toLowerCase();
  const mult = /cr/.test(unit) ? 10000000 : 100000;
  return {
    min: Math.round(parseFloat(m[1]) * mult),
    max: Math.round(parseFloat(m[2]) * mult),
    currency: 'INR',
  };
}

function parsePostedAt(bodyText) {
  const m = bodyText.match(/Posted\s+(Today|Yesterday|(\d+)\s+(day|week|month)s?\s+ago)/i);
  if (!m) return null;
  const now = new Date();
  if (/today/i.test(m[1])) return now.toISOString();
  if (/yesterday/i.test(m[1])) {
    now.setDate(now.getDate() - 1);
    return now.toISOString();
  }
  const n = parseInt(m[2], 10);
  const unit = m[3].toLowerCase();
  const days = unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : n;
  now.setDate(now.getDate() - days);
  return now.toISOString();
}

async function fetchDetailPage(id) {
  const url = `${BASE}/jobs/${id}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      timeout: REQUEST_TIMEOUT,
    });
    const $ = cheerio.load(data);
    const { title, company, location } = parseOgTitle($);
    if (!title) return null;
    if (!isProfessionalRole(title)) return null;

    // Description: the block following the "About the job" heading.
    let descriptionHtml = '';
    $('h1, h2, h3').each((_, el) => {
      if (descriptionHtml) return;
      if (/^about the job$/i.test($(el).text().trim())) {
        const next = $(el).next();
        descriptionHtml = (next.html() || next.text() || '').trim();
      }
    });

    const bodyText = $('body').text().replace(/\s+/g, ' ');
    if (!isLikelyEnglish(title, stripHtml(descriptionHtml) || bodyText.slice(0, 600))) return null;

    // Skills: pills following the "Skills" label.
    const skills = [];
    $('span, div, h3').each((_, el) => {
      if (skills.length) return;
      if ($(el).text().trim() === 'Skills') {
        $(el).parent().nextAll('div').first().children('div').each((__, pill) => {
          const t = $(pill).text().replace(/\s+/g, ' ').trim();
          if (t && !/^\+\d+\s*Skills?$/i.test(t) && t.length < 50) skills.push(t);
        });
      }
    });

    const parsed = parseDescription(descriptionHtml);

    // Salary: Indian "Lacs"/"Cr" format first, then generic text parsing.
    const salaryMatch = bodyText.match(/₹\s*[\d.]+\s*[-–—to]+\s*[\d.]+\s*(?:lacs?|lakhs?|cr|crores?)\s*(?:PA|p\.a\.?)?/i);
    let salary = salaryMatch ? parseIndianSalary(salaryMatch[0]) : null;
    if (!salary && salaryMatch) salary = parseSalaryText(salaryMatch[0]);
    if (!salary) salary = parsed.salary;

    const expMatch = bodyText.match(/Experience:\s*(\d+)\s*[-–—to]*\s*(\d+)?\s*Years/i);
    const minExp = expMatch ? parseInt(expMatch[1], 10) : null;
    let experience_level = parseExperienceLevelFromTitle(title) || parsed.experience_level;
    if (!experience_level && minExp != null) {
      experience_level = minExp <= 1 ? 'ENTRY' : minExp <= 5 ? 'MID' : 'SENIOR';
    }

    const workMode = /\bhybrid\b/i.test(bodyText)
      ? 'HYBRID'
      : /\bremote\b/i.test(bodyText)
        ? 'REMOTE'
        : /\bon-?site\b/i.test(bodyText)
          ? 'ONSITE'
          : null;

    const country_code = parseCountryCode(location || '') || null;

    return {
      title,
      source_url: url,
      description: descriptionHtml || `${title} at ${company || 'a company'}. ${location || ''}`.trim(),
      posted_at: parsePostedAt(bodyText),
      external_job_id: `sourcingxpress-${id}`,
      external_source: 'SourcingXpress',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: workMode === 'REMOTE',
      work_mode: workMode,
      location,
      country_code,
      job_type: /\binternship\b/i.test(title)
        ? 'INTERNSHIP'
        : /\bcontract\b/i.test(title)
          ? 'CONTRACT'
          : parsed.job_type || 'FULL_TIME',
      experience_level,
      salary_min: salary ? salary.min : null,
      salary_max: salary ? salary.max : null,
      salary_currency: salary ? salary.currency : null,
      skills: skills.length ? skills : parsed.skills,
      requirements: parsed.requirements,
      responsibilities: parsed.responsibilities,
      benefits: parsed.benefits,
      summary: parsed.summary || stripHtml(descriptionHtml).slice(0, 200),
      highlights: parsed.highlights,
      required_qualifications: parsed.required_qualifications,
      preferred_qualifications: parsed.preferred_qualifications,
      visa_sponsorship: parsed.visa_sponsorship,
      categories: [],
      company: company ? { name: company, country_code } : null,
    };
  } catch (err) {
    console.warn(`SourcingXpress: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeSourcingXpress() {
  console.log('SourcingXpress: fetching job listings...');
  const ids = await fetchListingIds();
  console.log(`SourcingXpress: discovered ${ids.length} job ids`);
  if (ids.length === 0) return [];

  const results = await fetchInBatches(ids, DETAIL_BATCH_SIZE, fetchDetailPage, 600);
  const jobs = results.filter(Boolean);
  console.log(`SourcingXpress: extracted ${jobs.length} jobs (${ids.length - jobs.length} dropped/failed)`);
  return jobs;
}

module.exports = scrapeSourcingXpress;
