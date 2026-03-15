const axios = require("axios");
const xml2js = require("xml2js");
const cheerio = require("cheerio");

const FEED_URL =
  "https://www.avjobs.com/special/RSS/rss_public_mgt_eng.asp";

const DETAIL_FETCH_DELAY = 500;
const DETAIL_FETCH_TIMEOUT = 10000;
const MAX_CONCURRENT = 2;

function parseLocationFromDesc(desc) {
  // Pattern 1: "City, State Country - " at start (may have leading comma for some entries)
  const match = desc.match(/^\s*\r?\n?\s*,?\s*(.+?(?:United States|United Kingdom|Canada|Australia|Estonia|Cayman Islands|Germany|South Korea|Poland|France|Japan|India|[A-Z]{2}\s))\s*-/);
  if (match) {
    return match[1].trim().replace(/^,\s*/, '');
  }
  // Pattern 2: "City, ST" at very start
  const match2 = desc.match(/^\s*\r?\n?\s*,?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+)*)\s*-/);
  if (match2) {
    return match2[1].trim().replace(/^,\s*/, '');
  }
  return null;
}

function parseCompanyFromDesc(desc) {
  // Pattern 1: "At Boeing, we..." or "At Company Name, ..."
  const atMatch = desc.match(/\bAt\s+([A-Z][A-Za-z\s&.'-]+?),\s+we\b/);
  if (atMatch) return atMatch[1].trim();

  // Pattern 2: "Tactical Air Support Inc." — company name with Inc/LLC/Corp
  const incMatch = desc.match(/\b([A-Z][A-Za-z\s&.'-]*?\s+(?:Inc\.?|LLC|Corp\.?|Ltd\.?|Co\.?))\b/);
  if (incMatch) return incMatch[1].trim();

  // Pattern 3: "Join our fantastic Menzies Aviation team" or "Menzies Aviation (MA)"
  const joinMatch = desc.match(/(?:join|of)\s+(?:our\s+)?(?:fantastic\s+)?([A-Z][A-Za-z\s&.'-]+?)(?:\s+team|\s*\()/i);
  if (joinMatch) return joinMatch[1].trim();

  // Pattern 4: "People. Passion. Pride" + "global aviation" → Menzies Aviation
  if (/People\.\s*Passion\.\s*Pride/i.test(desc) || /Menzies\s*Aviation/i.test(desc)) {
    return "Menzies Aviation";
  }

  return null;
}

function extractJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      let text = $(scripts[i]).html();
      // AVJobs JSON-LD contains JS-style comments (// ...) — strip them
      text = text.replace(/^\s*\/\/.*$/gm, "");
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item["@type"] === "JobPosting") return item;
        if (item["@graph"]) {
          const posting = item["@graph"].find((g) => g["@type"] === "JobPosting");
          if (posting) return posting;
        }
      }
    } catch {}
  }
  return null;
}

function parseDetailPage($) {
  const result = {};

  // Try JSON-LD first (primary source of structured data)
  const jsonLd = extractJsonLd($);
  if (jsonLd) {
    if (jsonLd.description) {
      result.description = jsonLd.description;
    }
    if (jsonLd.hiringOrganization?.name) {
      result.company = jsonLd.hiringOrganization.name;
    }
    if (jsonLd.jobLocation) {
      const loc = Array.isArray(jsonLd.jobLocation) ? jsonLd.jobLocation[0] : jsonLd.jobLocation;
      if (loc?.address) {
        const addr = loc.address;
        const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
        if (parts.length) result.location = parts.join(", ");
      }
    }
    if (jsonLd.datePosted) {
      result.posted_at = new Date(jsonLd.datePosted).toISOString();
    }
    if (jsonLd.validThrough) {
      result.expires_at = new Date(jsonLd.validThrough).toISOString();
    }
    if (jsonLd.employmentType) {
      const type = Array.isArray(jsonLd.employmentType) ? jsonLd.employmentType[0] : jsonLd.employmentType;
      if (/full/i.test(type)) result.job_type = "FULL_TIME";
      else if (/part/i.test(type)) result.job_type = "PART_TIME";
      else if (/contract/i.test(type)) result.job_type = "CONTRACT";
    }
    if (jsonLd.identifier?.value) {
      result.job_id = jsonLd.identifier.value;
    }
    if (jsonLd.baseSalary?.value) {
      const val = jsonLd.baseSalary.value;
      result.salary_min = val.minValue || val.value || null;
      result.salary_max = val.maxValue || val.value || null;
      result.salary_currency = jsonLd.baseSalary.currency || "USD";
    }
  }

  // Fallback: extract description from page content if JSON-LD didn't have it
  if (!result.description) {
    // Try common description selectors
    const descEl = $(".ats-description") || $(".job-description") || $("article") || $("main .content");
    if (descEl && descEl.length) {
      result.description = descEl.html().trim();
    }
  }

  // Fallback: parse structured fields from body text
  const bodyText = $("body").text();

  if (!result.company) {
    const companyMatch = bodyText.match(/Featured\s+(.+?)\s+Location/);
    if (companyMatch) result.company = companyMatch[1].trim();
  }

  if (!result.location) {
    const locationMatch = bodyText.match(/Location\s+(.+?)\s+(?:Wage|Job ID|Posted)/);
    if (locationMatch) result.location = locationMatch[1].trim();
  }

  if (!result.job_id) {
    const jobIdMatch = bodyText.match(/Job ID\s+(\S+)/);
    if (jobIdMatch) result.job_id = jobIdMatch[1].trim();
  }

  if (!result.posted_at) {
    const postedMatch = bodyText.match(/Posted\s+(\d{4}-\d{1,2}-\d{1,2})/);
    if (postedMatch) result.posted_at = new Date(postedMatch[1]).toISOString();
  }

  return result;
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
    return parseDetailPage($);
  } catch (err) {
    console.warn(`Failed to fetch AVJobs detail page ${url}: ${err.message}`);
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function scrapeAVJobs() {
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  const items = parsed.rss.channel.item;
  const rssItems = Array.isArray(items) ? items : [items];

  console.log(`Fetched ${rssItems.length} RSS items from AVJobs, fetching detail pages...`);

  // Fetch detail pages in batches of MAX_CONCURRENT with delays
  const detailResults = await processInBatches(
    rssItems,
    MAX_CONCURRENT,
    DETAIL_FETCH_DELAY,
    async (item) => {
      if (!item.link) return null;
      await delay(Math.random() * DETAIL_FETCH_DELAY);
      return fetchDetailPage(item.link);
    }
  );

  const jobs = rssItems.map((item, idx) => {
    const urlPath = (item.link || "").split("/").filter(Boolean).pop() || item.link;
    const rssDesc = item.description || "";
    const detail = detailResults[idx];

    const location = detail?.location || parseLocationFromDesc(rssDesc);
    const companyName = detail?.company || parseCompanyFromDesc(rssDesc);
    const description = detail?.description || rssDesc;
    const posted_at = detail?.posted_at || (item.pubDate ? new Date(item.pubDate).toISOString() : null);

    const job = {
      title: item.title,
      source_url: item.link,
      description,
      posted_at,
      external_job_id: detail?.job_id || urlPath,
      external_source: "AVJobs",
      source_type: "RSS",
      source_base_url: "https://www.avjobs.com",
      is_remote: false,
      location,
      categories: [],
      company: companyName ? {
        name: companyName,
        industry: "Aviation",
      } : null,
    };

    if (detail?.job_type) job.job_type = detail.job_type;
    if (detail?.salary_min) {
      job.salary_min = detail.salary_min;
      job.salary_max = detail.salary_max;
      job.salary_currency = detail.salary_currency;
    }
    if (detail?.expires_at) job.expires_at = detail.expires_at;

    return job;
  });

  console.log(`Scraped ${jobs.length} jobs from AVJobs (with detail pages)`);
  return jobs;
}

module.exports = scrapeAVJobs;
