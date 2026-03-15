const axios = require("axios");
const xml2js = require("xml2js");
const cheerio = require("cheerio");
const { parseCountryCode } = require("../lib/descriptionParser");

const FEED_URLS = [
  "https://www.realworkfromanywhere.com/remote-developer-jobs/rss.xml",
  "https://www.realworkfromanywhere.com/remote-design-jobs/rss.xml",
  "https://www.realworkfromanywhere.com/remote-marketing-jobs/rss.xml",
  "https://www.realworkfromanywhere.com/remote-data-jobs/rss.xml",
  "https://www.realworkfromanywhere.com/remote-devops-jobs/rss.xml",
];

const DETAIL_FETCH_DELAY = 500;
const DETAIL_FETCH_TIMEOUT = 10000;
const MAX_CONCURRENT = 2;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const data = JSON.parse($(scripts[i]).html());
      // Could be a single object or an array
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item["@type"] === "JobPosting") {
          return item;
        }
        // Check @graph array (common in structured data)
        if (item["@graph"]) {
          const posting = item["@graph"].find((g) => g["@type"] === "JobPosting");
          if (posting) return posting;
        }
      }
    } catch {
      // Skip malformed JSON-LD
    }
  }
  return null;
}

async function fetchDetailPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: DETAIL_FETCH_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });
    const $ = cheerio.load(response.data);
    const jsonLd = extractJsonLd($);
    if (!jsonLd) return null;

    const result = {};

    if (jsonLd.description) {
      result.description = jsonLd.description;
    }

    if (jsonLd.hiringOrganization) {
      const org = jsonLd.hiringOrganization;
      result.company_name = org.name || null;
      result.company_logo = org.logo || null;
      result.company_url = org.sameAs || org.url || null;
    }

    if (jsonLd.employmentType) {
      const type = Array.isArray(jsonLd.employmentType)
        ? jsonLd.employmentType[0]
        : jsonLd.employmentType;
      result.employment_type = type;
    }

    if (jsonLd.datePosted) {
      result.date_posted = new Date(jsonLd.datePosted).toISOString();
    }

    if (jsonLd.validThrough) {
      result.valid_through = new Date(jsonLd.validThrough).toISOString();
    }

    if (jsonLd.jobLocationType) {
      result.is_remote = jsonLd.jobLocationType === "TELECOMMUTE";
    }

    if (jsonLd.jobLocation) {
      const loc = Array.isArray(jsonLd.jobLocation)
        ? jsonLd.jobLocation[0]
        : jsonLd.jobLocation;
      if (loc?.address) {
        const addr = loc.address;
        const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
        if (parts.length) result.location = parts.join(", ");
      }
      if (loc?.address?.addressCountry) {
        result.country_code = loc.address.addressCountry;
      }
    }

    // If no country from jobLocation, try applicantLocationRequirements
    if (!result.country_code && jsonLd.applicantLocationRequirements) {
      const reqs = Array.isArray(jsonLd.applicantLocationRequirements)
        ? jsonLd.applicantLocationRequirements
        : [jsonLd.applicantLocationRequirements];
      // If only 1 country listed, use it; if many (>5), it's worldwide
      const countries = reqs
        .filter(r => r["@type"] === "Country")
        .map(r => r.name)
        .filter(Boolean);
      if (countries.length === 1) {
        result.country_code = countries[0]; // Usually an ISO code
      } else if (countries.length > 0 && countries.length <= 5) {
        // Few specific countries — use the first one
        result.country_code = countries[0];
      }
      // If >5 countries, it's worldwide — leave null
    }

    // Salary from JSON-LD
    const salary = jsonLd.baseSalary || jsonLd.estimatedSalary;
    if (salary?.value) {
      const val = salary.value;
      result.salary_min = val.minValue || val.value || null;
      result.salary_max = val.maxValue || val.value || null;
      result.salary_currency = salary.currency || "USD";
    }

    return result;
  } catch (err) {
    console.warn(`Failed to fetch RWFA detail page ${url}: ${err.message}`);
    return null;
  }
}

function mapEmploymentType(type) {
  if (!type) return null;
  const upper = type.toUpperCase().replace(/[- ]/g, "_");
  if (upper.includes("FULL")) return "FULL_TIME";
  if (upper.includes("PART")) return "PART_TIME";
  if (upper.includes("CONTRACT")) return "CONTRACT";
  if (upper.includes("INTERN")) return "INTERNSHIP";
  return upper;
}

async function processInBatches(items, batchSize, delayMs, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await delay(delayMs);
    }
  }
  return results;
}

async function scrapeRealWorkFromAnywhere() {
  const parser = new xml2js.Parser({
    explicitArray: true,
    strict: false,
    trim: true,
  });

  // Fetch all feeds, collecting items and deduplicating by link URL
  const seenLinks = new Set();
  const items = [];

  for (const feedUrl of FEED_URLS) {
    try {
      const response = await axios.get(feedUrl, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const parsed = await parser.parseStringPromise(response.data);
      const channel = parsed?.RSS?.CHANNEL?.[0];
      const feedItems = channel?.ITEM || [];

      let addedCount = 0;
      for (const item of feedItems) {
        const link = item.LINK?.[0] || "";
        if (link && !seenLinks.has(link)) {
          seenLinks.add(link);
          items.push(item);
          addedCount++;
        }
      }

      console.log(`RWFA feed ${feedUrl.split("/").slice(-2, -1)[0]}: ${feedItems.length} items (${addedCount} new)`);
    } catch (err) {
      console.warn(`Failed to fetch RWFA feed ${feedUrl}: ${err.message}`);
    }
  }

  if (items.length === 0) {
    console.log("No jobs found in RealWorkFromAnywhere feeds");
    return [];
  }

  console.log(`Fetched ${items.length} unique RSS items from RealWorkFromAnywhere, fetching detail pages...`);

  // Fetch detail pages for JSON-LD data
  const detailResults = await processInBatches(
    items,
    MAX_CONCURRENT,
    DETAIL_FETCH_DELAY,
    async (item) => {
      const link = item.LINK?.[0] || "";
      if (!link) return null;
      await delay(Math.random() * DETAIL_FETCH_DELAY);
      return fetchDetailPage(link);
    }
  );

  const jobs = items.map((item, idx) => {
    const title = item.TITLE?.[0] || "";
    const link = item.LINK?.[0] || "";
    const rssDescription = item.DESCRIPTION?.[0] || "";
    const pubDate = item.PUBDATE?.[0] || null;
    const detail = detailResults[idx];

    const urlPath = link.split("/").filter(Boolean).pop() || link;

    // Try to extract company name from title pattern "Title at Company"
    let companyName = null;
    const atMatch = title.match(/\bat\s+(.+)$/i);
    if (atMatch) {
      companyName = atMatch[1].trim();
    }

    // Clean the title — remove "at Company" suffix for the job title
    let cleanTitle = title;
    if (atMatch) {
      cleanTitle = title.substring(0, title.lastIndexOf(" at ")).trim();
    }

    // Override with JSON-LD data when available
    const description = detail?.description || rssDescription;
    const posted_at = detail?.date_posted || (pubDate ? new Date(pubDate).toISOString() : null);
    const finalCompanyName = detail?.company_name || companyName;
    const location = detail?.location || "Remote";
    const is_remote = detail?.is_remote ?? true;

    const job = {
      title: cleanTitle || title,
      source_url: link,
      description,
      posted_at,
      external_job_id: urlPath,
      external_source: "RealWorkFromAnywhere",
      source_type: "RSS",
      source_base_url: "https://www.realworkfromanywhere.com",
      is_remote,
      location,
      categories: [],
      company: finalCompanyName ? {
        name: finalCompanyName,
        logo_url: detail?.company_logo || null,
        website: detail?.company_url || null,
      } : null,
    };

    // Add salary if found in JSON-LD
    if (detail?.salary_min) job.salary_min = detail.salary_min;
    if (detail?.salary_max) job.salary_max = detail.salary_max;
    if (detail?.salary_currency) job.salary_currency = detail.salary_currency;

    // Add job type from JSON-LD
    if (detail?.employment_type) {
      job.job_type = mapEmploymentType(detail.employment_type);
    }

    // Add expiry date
    if (detail?.valid_through) job.expires_at = detail.valid_through;

    // Add country code
    job.country_code = parseCountryCode(detail?.country_code || detail?.location) || null;

    return job;
  });

  console.log(`Scraped ${jobs.length} jobs from RealWorkFromAnywhere (with detail pages)`);
  return jobs;
}

module.exports = scrapeRealWorkFromAnywhere;
