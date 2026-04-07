const axios = require("axios");
const xml2js = require("xml2js");
const playwright = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require("user-agents");
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
} = require("../lib/descriptionParser");

playwright.chromium.use(StealthPlugin());

const FEED_URL = "https://jobicy.com/feed/job_feed";

const DETAIL_BATCH_SIZE = 5;
const DETAIL_PAGE_TIMEOUT = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapJobType(type) {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower.includes("full")) return "FULL_TIME";
  if (lower.includes("part")) return "PART_TIME";
  if (lower.includes("contract") || lower.includes("freelance")) return "CONTRACT";
  if (lower.includes("intern")) return "INTERNSHIP";
  return null;
}

async function fetchDetailPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: "load",
      timeout: DETAIL_PAGE_TIMEOUT,
    });

    const detail = await page.evaluate(() => {
      const result = {};

      // Try JSON-LD first
      const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const posting = item['@type'] === 'JobPosting' ? item : item['@graph']?.find(g => g['@type'] === 'JobPosting');
            if (posting) {
              if (posting.baseSalary?.value) {
                const val = posting.baseSalary.value;
                result.salary_min = val.minValue || val.value || null;
                result.salary_max = val.maxValue || val.value || null;
                result.salary_currency = posting.baseSalary.currency || 'USD';
              }
              if (posting.datePosted) result.posted_at = posting.datePosted;
              if (posting.jobLocation) {
                const loc = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
                if (loc?.address?.addressCountry) result.country = loc.address.addressCountry;
              }
              break;
            }
          }
        } catch {}
      }

      // Company logo from the detail page (bypasses hotlink protection)
      const logoImg = document.querySelector(".company-logo img, .job-header img, img[class*='logo']");
      if (logoImg && logoImg.src) {
        result.company_logo = logoImg.src;
      }

      // Salary info from structured display
      const salaryEl = document.querySelector(".salary, [class*='salary'], [class*='compensation']");
      if (salaryEl) {
        const salaryText = salaryEl.innerText.trim();
        result.salary_text = salaryText;

        const match = salaryText.match(/\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/);
        if (match) {
          result.salary_min = parseInt(match[1].replace(/,/g, ""), 10);
          result.salary_max = parseInt(match[2].replace(/,/g, ""), 10);
          result.salary_currency = "USD";
        }
        // EUR pattern
        const eurMatch = salaryText.match(/€\s?([\d,]+)\s*[-–—to]+\s*€?\s*([\d,]+)/);
        if (!match && eurMatch) {
          result.salary_min = parseInt(eurMatch[1].replace(/,/g, ""), 10);
          result.salary_max = parseInt(eurMatch[2].replace(/,/g, ""), 10);
          result.salary_currency = "EUR";
        }
      }

      // Fallback: search body text for salary patterns if not yet found
      if (!result.salary_min) {
        const bodyText = document.body.innerText || "";

        // USD pattern: $60,000 - $80,000
        const usdMatch = bodyText.match(/\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/);
        if (usdMatch) {
          result.salary_min = parseInt(usdMatch[1].replace(/,/g, ""), 10);
          result.salary_max = parseInt(usdMatch[2].replace(/,/g, ""), 10);
          result.salary_currency = "USD";
        }

        // EUR pattern: €50,000 - €70,000
        if (!result.salary_min) {
          const eurBodyMatch = bodyText.match(/€\s?([\d,]+)\s*[-–—to]+\s*€?\s*([\d,]+)/);
          if (eurBodyMatch) {
            result.salary_min = parseInt(eurBodyMatch[1].replace(/,/g, ""), 10);
            result.salary_max = parseInt(eurBodyMatch[2].replace(/,/g, ""), 10);
            result.salary_currency = "EUR";
          }
        }

        // K-format: 50K-70K EUR or 60K-80K USD
        if (!result.salary_min) {
          const kMatch = bodyText.match(/([\d]+)\s*K\s*[-–—to]+\s*([\d]+)\s*K\s*(EUR|USD)/i);
          if (kMatch) {
            result.salary_min = parseInt(kMatch[1], 10) * 1000;
            result.salary_max = parseInt(kMatch[2], 10) * 1000;
            result.salary_currency = kMatch[3].toUpperCase();
          }
        }
      }

      // Company website
      const companyLink = document.querySelector("a[href*='company'], a.company-link");
      if (companyLink && companyLink.href && !companyLink.href.includes("jobicy.com")) {
        result.company_website = companyLink.href;
      }

      // Additional location details
      const locationEl = document.querySelector(".location, [class*='location']");
      if (locationEl) {
        result.location = locationEl.innerText.trim();
      }

      // Extract metadata from dt/dd pairs in header
      const dtElements = document.querySelectorAll("dt");
      for (const dt of dtElements) {
        const dtText = dt.innerText.trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (!dd || dd.tagName !== "DD") continue;
        const ddText = dd.innerText.trim();

        if (dtText.includes("experience")) {
          result.experience_level_text = ddText;
        } else if (dtText.includes("salary") && !result.salary_min) {
          result.salary_text = ddText;
        } else if (dtText.includes("employment")) {
          result.employment_type = ddText;
        }
      }

      // Get the full job description HTML
      const descEl = document.querySelector(".job__desc");
      if (descEl) {
        result.description_html = descEl.innerHTML.trim();
      }

      return result;
    });

    return detail;
  } catch (err) {
    console.warn(`Failed to fetch Jobicy detail page ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeJobicy() {
  // Step 1: Fetch RSS feed
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  const items = parsed.rss.channel.item;
  const rssItems = Array.isArray(items) ? items : [items];

  console.log(`Fetched ${rssItems.length} RSS items from Jobicy, fetching detail pages...`);

  // Step 2: Launch Playwright for detail pages
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: new UserAgent().toString(),
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });

  try {
    // Fetch detail pages in batches
    const detailResults = [];
    for (let i = 0; i < rssItems.length; i += DETAIL_BATCH_SIZE) {
      const batch = rssItems.slice(i, i + DETAIL_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((item) => fetchDetailPage(context, item.link))
      );
      detailResults.push(...batchResults);

      if (i + DETAIL_BATCH_SIZE < rssItems.length) {
        await delay(500 + Math.random() * 500);
      }
      console.log(`  Detail pages: ${Math.min(i + DETAIL_BATCH_SIZE, rssItems.length)}/${rssItems.length}`);
    }

    const jobs = rssItems.map((item, idx) => {
      const detail = detailResults[idx];

      const categories = item.category
        ? Array.isArray(item.category)
          ? item.category
          : [item.category]
        : [];

      // Extract numeric ID from URL
      const idMatch = (item.link || "").match(/\/job\/(\d+)/);
      const externalId = idMatch ? idMatch[1] : (item.link || "").split("/").filter(Boolean).pop();

      // Use content:encoded for full description, fallback to description
      const fullDescription = item["content:encoded"] || item.description || "";

      // Use structured fields from Jobicy RSS
      const companyName = item["job_listing:company"] || null;
      const location = detail?.location || item["job_listing:location"] || "Remote";
      const jobType = mapJobType(item["job_listing:job_type"]);

      // Company logo: prefer detail page (bypasses hotlink), fallback to RSS media:content
      let logoUrl = detail?.company_logo || null;
      if (!logoUrl && item["media:content"] && item["media:content"].$) {
        logoUrl = item["media:content"].$.url || null;
      }

      // Parse structured fields from description HTML
      const parsed = parseDescription(fullDescription);

      // Salary: detail page > RSS field > parsed from description
      let salary_min = detail?.salary_min || null;
      let salary_max = detail?.salary_max || null;
      let salary_currency = detail?.salary_currency || null;

      if (!salary_min && item["job_listing:salary"]) {
        const rssSalary = item["job_listing:salary"];
        const usdMatch = rssSalary.match(/\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/);
        if (usdMatch) {
          salary_min = parseInt(usdMatch[1].replace(/,/g, ""), 10);
          salary_max = parseInt(usdMatch[2].replace(/,/g, ""), 10);
          salary_currency = "USD";
        } else {
          const eurMatch = rssSalary.match(/€\s?([\d,]+)\s*[-–—to]+\s*€?\s*([\d,]+)/);
          if (eurMatch) {
            salary_min = parseInt(eurMatch[1].replace(/,/g, ""), 10);
            salary_max = parseInt(eurMatch[2].replace(/,/g, ""), 10);
            salary_currency = "EUR";
          }
        }
      }

      if (!salary_min && parsed.salary) {
        salary_min = parsed.salary.min;
        salary_max = parsed.salary.max;
        salary_currency = parsed.salary.currency;
      }

      const job = {
        title: item.title,
        source_url: item.link,
        description: fullDescription,
        posted_at: detail?.posted_at || (item.pubDate ? new Date(item.pubDate).toISOString() : null),
        external_job_id: externalId,
        external_source: "Jobicy",
        source_type: "RSS",
        source_base_url: "https://jobicy.com",
        is_remote: true,
        location,
        job_type: jobType || parsed.job_type || null,
        experience_level: parseExperienceLevelFromTitle(item.title) || parsed.experience_level || null,
        salary_min,
        salary_max,
        salary_currency,
        skills: parsed.skills.length > 0 ? parsed.skills : [],
        requirements: parsed.requirements.length > 0 ? parsed.requirements : [],
        responsibilities: parsed.responsibilities.length > 0 ? parsed.responsibilities : [],
        benefits: parsed.benefits.length > 0 ? parsed.benefits : [],
        summary: parsed.summary || null,
        highlights: parsed.highlights.length > 0 ? parsed.highlights : [],
        required_qualifications: parsed.required_qualifications.length > 0 ? parsed.required_qualifications : [],
        preferred_qualifications: parsed.preferred_qualifications.length > 0 ? parsed.preferred_qualifications : [],
        visa_sponsorship: parsed.visa_sponsorship || false,
        categories,
        company: companyName ? {
          name: companyName,
          logo_url: logoUrl,
          website: detail?.company_website || null,
        } : null,
      };

      // Parse country code from location
      job.country_code = parseCountryCode(detail?.country || detail?.location || item["job_listing:location"]) || null;

      return job;
    });

    console.log(`Scraped ${jobs.length} jobs from Jobicy (with detail pages)`);
    return jobs;
  } catch (err) {
    console.error("Error fetching Jobicy detail pages:", err.message);
    // Fall back to RSS-only data
    return rssItems.map((item) => {
      const categories = item.category
        ? Array.isArray(item.category) ? item.category : [item.category]
        : [];
      const idMatch = (item.link || "").match(/\/job\/(\d+)/);
      const externalId = idMatch ? idMatch[1] : (item.link || "").split("/").filter(Boolean).pop();
      const companyName = item["job_listing:company"] || null;
      let logoUrl = null;
      if (item["media:content"] && item["media:content"].$) {
        logoUrl = item["media:content"].$.url || null;
      }
      return {
        title: item.title,
        source_url: item.link,
        description: item["content:encoded"] || item.description || "",
        posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
        external_job_id: externalId,
        external_source: "Jobicy",
        source_type: "RSS",
        source_base_url: "https://jobicy.com",
        is_remote: true,
        location: item["job_listing:location"] || "Remote",
        job_type: mapJobType(item["job_listing:job_type"]),
        categories,
        company: companyName ? { name: companyName, logo_url: logoUrl } : null,
        country_code: parseCountryCode(item["job_listing:location"]) || null,
      };
    });
  } finally {
    await browser.close();
  }
}

module.exports = scrapeJobicy;
