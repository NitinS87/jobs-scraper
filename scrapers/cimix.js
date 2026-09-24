const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
  stripHtml,
} = require('../lib/descriptionParser');
const { fetchInBatches } = require('../lib/scraperUtils');
const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');
const { activeSlices } = require('../lib/verticals');

// Cimix is a Nordic job board (Sweden/Denmark/Norway/Finland). The listing is a
// Next.js RSC page that shows 50 jobs per category and ignores ?page; the only
// server-side filter that changes the result set is ?categoryId. So we iterate
// over the tech / white-collar professional categories and dedupe. Detail pages
// expose a clean JSON-LD JobPosting (titles are translated to English).
const BASE = 'https://www.cimix.ai';
const LISTING_URL = (categoryId) => `${BASE}/en/jobs?categoryId=${categoryId}`;

// Tech + professional categories only (skips healthcare, hotel, cleaning, etc.).
const CATEGORIES = [
  'category_manual_it_006',
  'category_administration_finance_law_010',
  'category_managers_executives_011',
  'category_sales_procurement_marketing_012',
  'category_technical_work_017',
  'category_scientific_work_018',
  'category_culture_media_design_020',
  'category_education_013',
  // The site exposes 20 category ids; these five map onto taxonomy roots that
  // were previously empty or thin (Real Estate/Architecture, Healthcare,
  // Production/Manufacturing, Electrical Engineering, Energy/Environmental).
  // Deliberately still excluded: beauty, crafts, hotel/restaurant, sanitation,
  // security, social work and transport — none has a home in the 392 nodes.
  'category_construction_civil_001',
  'category_healthcare_003',
  'category_industrial_production_007',
  'category_installation_operation_maintenance_009',
  'category_sustainable_agriculture_019',
];

const MAX_JOBS = Number(process.env.CIMIX_MAX_JOBS) || 500;
const DETAIL_BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 30000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const JOB_LINK_REGEX = /\/en\/jobs\/([a-z0-9]{20,})$/;

function extractJsonLd($) {
  const postings = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const graph = item['@graph'] ? item['@graph'] : [item];
        for (const node of graph) {
          if (node && node['@type'] === 'JobPosting') postings.push(node);
        }
      }
    } catch {}
  });
  return postings;
}

function mapEmploymentType(t) {
  if (!t) return null;
  const v = String(Array.isArray(t) ? t[0] : t).toUpperCase().replace(/[-\s]+/g, '_');
  if (v.includes('FULL_TIME')) return 'FULL_TIME';
  if (v.includes('PART_TIME')) return 'PART_TIME';
  if (v.includes('CONTRACT')) return 'CONTRACT';
  if (v.includes('INTERN')) return 'INTERNSHIP';
  if (v.includes('TEMPORARY') || v.includes('FREELANCE')) return 'FREELANCE';
  return null;
}

function buildLocation(ld) {
  const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
  const addr = (loc && loc.address) || {};
  const segs = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
    .filter(Boolean)
    .map((s) => String(s).trim());
  return { text: [...new Set(segs)].join(', ') || null, country: addr.addressCountry || null };
}

// Category ids grouped by taxonomy root; only the roots active in this run's
// rotation are fetched (lib/verticals.js). Each category is a separate listing
// plus detail-page pass, so slice count is real cost here.
const SLICE_MAP = {
  'software-internet-ai': ['category_manual_it_006'],
  'human-resource-administrative-legal': ['category_administration_finance_law_010'],
  accounting: ['category_administration_finance_law_010'],
  finance: ['category_administration_finance_law_010'],
  'legal-services': ['category_administration_finance_law_010'],
  consulting: ['category_managers_executives_011'],
  sales: ['category_sales_procurement_marketing_012'],
  marketing: ['category_sales_procurement_marketing_012'],
  'logistics-supply-chain': ['category_sales_procurement_marketing_012'],
  'electrical-engineering': ['category_technical_work_017', 'category_installation_operation_maintenance_009'],
  healthcare: ['category_scientific_work_018', 'category_healthcare_003'],
  'creative-design': ['category_culture_media_design_020'],
  'education-and-training': ['category_education_013'],
  'real-estate-architecture': ['category_construction_civil_001'],
  'production-manufacturing': ['category_industrial_production_007'],
  'energy-environmental': ['category_sustainable_agriculture_019'],
};

async function collectJobIds() {
  const ids = new Set();
  const { slices, roots } = activeSlices('Cimix', SLICE_MAP);
  const categories = slices.length ? slices : CATEGORIES;
  console.log(`Cimix: ${categories.length} categories across roots [${roots.join(', ')}]`);
  for (const cat of categories) {
    if (ids.size >= MAX_JOBS) break;
    try {
      const { data } = await axios.get(LISTING_URL(cat), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        timeout: REQUEST_TIMEOUT,
      });
      const $ = cheerio.load(data);
      $('a[href*="/jobs/"]').each((_, el) => {
        const m = ($(el).attr('href') || '').split('?')[0].match(JOB_LINK_REGEX);
        if (m) ids.add(m[1]);
      });
    } catch (err) {
      console.warn(`Cimix: listing ${cat} failed: ${err.message}`);
    }
  }
  return [...ids].slice(0, MAX_JOBS);
}

async function fetchDetailPage(id) {
  const url = `${BASE}/en/jobs/${id}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      timeout: REQUEST_TIMEOUT,
    });
    const $ = cheerio.load(data);
    const ld = extractJsonLd($)[0];
    if (!ld || !ld.title) return null;

    const title = String(ld.title).trim();
    if (!isProfessionalRole(title)) return null;

    const descriptionHtml = ld.description || '';
    const descText = stripHtml(descriptionHtml);
    if (!isLikelyEnglish(title, descText)) return null;

    const { text: location, country } = buildLocation(ld);
    const country_code = (country && /^[A-Z]{2}$/.test(country) ? country : null) || parseCountryCode(location || '');
    const parsed = parseDescription(descriptionHtml);
    const org = ld.hiringOrganization || {};

    // Cimix qualifications field can supplement extracted requirements.
    let requirements = parsed.requirements;
    if ((!requirements || !requirements.length) && ld.qualifications) {
      const q = stripHtml(String(ld.qualifications));
      if (q) requirements = [q];
    }

    return {
      title,
      source_url: url,
      description: descriptionHtml,
      posted_at: ld.datePosted ? new Date(ld.datePosted).toISOString() : null,
      external_job_id: `cimix-${id}`,
      external_source: 'Cimix',
      source_type: 'SCRAPER',
      source_base_url: BASE,
      is_remote: /remote|distans|hjemmefra/i.test(location || '') || /remote/i.test(title),
      location,
      country_code,
      job_type: mapEmploymentType(ld.employmentType) || parsed.job_type,
      experience_level: parseExperienceLevelFromTitle(title) || parsed.experience_level,
      salary_min: parsed.salary ? parsed.salary.min : null,
      salary_max: parsed.salary ? parsed.salary.max : null,
      salary_currency: parsed.salary ? parsed.salary.currency : null,
      skills: parsed.skills,
      requirements,
      responsibilities: parsed.responsibilities,
      benefits: parsed.benefits,
      summary: parsed.summary || descText.slice(0, 200),
      highlights: parsed.highlights,
      required_qualifications: requirements,
      preferred_qualifications: parsed.preferred_qualifications,
      visa_sponsorship: parsed.visa_sponsorship,
      categories: ld.industry ? [String(ld.industry)] : [],
      company: {
        name: org.name || null,
        logo_url: typeof org.logo === 'string' ? org.logo : org.logo?.url || null,
        website: typeof org.url === 'string' && /^https?:\/\//.test(org.url) ? org.url : null,
        country_code,
      },
    };
  } catch (err) {
    console.warn(`Cimix: detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function scrapeCimix() {
  console.log('Cimix: collecting job ids across professional categories...');
  const ids = await collectJobIds();
  console.log(`Cimix: discovered ${ids.length} unique job ids`);
  if (ids.length === 0) return [];

  const results = await fetchInBatches(ids, DETAIL_BATCH_SIZE, fetchDetailPage, 600);
  const jobs = results.filter(Boolean);
  console.log(`Cimix: extracted ${jobs.length} jobs (${ids.length - jobs.length} dropped/failed)`);
  return jobs;
}

module.exports = scrapeCimix;
module.exports.SLICE_MAP = SLICE_MAP;
