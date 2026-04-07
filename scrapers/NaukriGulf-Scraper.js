const playwright = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
} = require("../lib/descriptionParser");

playwright.chromium.use(StealthPlugin());

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE_URL = "https://www.naukrigulf.com";

function isValidUrl(str) {
  if (!str) return false;
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
const START_URL = `${BASE_URL}/software-engineer-jobs?easyApply=false`;
const MAX_JOBS = 100;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2000;

function parseExperienceToLevel(expStr) {
  if (!expStr) return null;
  const match = expStr.match(/(\d+)/);
  if (!match) return null;
  const years = parseInt(match[1], 10);
  if (years <= 2) return "ENTRY";
  if (years <= 5) return "MID";
  if (years <= 10) return "SENIOR";
  return "EXECUTIVE";
}

function parseSalary(salaryStr) {
  if (!salaryStr) return { min: null, max: null, currency: null };
  const match = salaryStr.match(
    /(AED|USD|EUR)?\s*([\d,]+)\s*[-\u2013\u2014to]+\s*([\d,]+)\s*(AED|USD|EUR)?/i
  );
  if (!match) return { min: null, max: null, currency: null };
  return {
    min: parseInt(match[2].replace(/,/g, ""), 10),
    max: parseInt(match[3].replace(/,/g, ""), 10),
    currency: (match[1] || match[4] || "AED").toUpperCase(),
  };
}

function mapJobType(typeStr) {
  if (!typeStr) return null;
  const lower = typeStr.toLowerCase().replace(/[_-]/g, " ");
  if (lower.includes("full") && lower.includes("time")) return "FULL_TIME";
  if (lower.includes("full")) return "FULL_TIME";
  if (lower.includes("part") && lower.includes("time")) return "PART_TIME";
  if (lower.includes("part")) return "PART_TIME";
  if (lower.includes("contract")) return "CONTRACT";
  if (lower.includes("intern")) return "INTERNSHIP";
  if (lower.includes("freelance")) return "FREELANCE";
  if (lower.includes("temporary") || lower.includes("temp")) return "CONTRACT";
  if (lower.includes("permanent")) return "FULL_TIME";
  return null;
}

function extractJsonLd(page) {
  return page.evaluate(() => {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data["@type"] === "JobPosting") return data;
        if (Array.isArray(data)) {
          const posting = data.find((d) => d["@type"] === "JobPosting");
          if (posting) return posting;
        }
      } catch {
        // ignore malformed JSON-LD
      }
    }
    return null;
  });
}

async function scrapeDetailPage(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Try JSON-LD first
    const jsonLd = await extractJsonLd(page);

    let title = null;
    let company = "Not Mentioned";
    let location = null;
    let salaryStr = null;
    let experienceStr = null;
    let jobTypeStr = null;
    let descriptionHtml = "";
    let companyWebsite = null;
    let postedAt = null;
    let reqQuals = [];

    if (jsonLd) {
      title = jsonLd.title || null;
      company =
        jsonLd.hiringOrganization?.name || company;
      const candidateWebsite =
        jsonLd.hiringOrganization?.sameAs ||
        jsonLd.hiringOrganization?.url ||
        null;
      companyWebsite = isValidUrl(candidateWebsite) ? candidateWebsite : null;
      location =
        jsonLd.jobLocation?.address?.addressLocality ||
        jsonLd.jobLocation?.address?.addressRegion ||
        null;
      descriptionHtml = jsonLd.description || "";
      jobTypeStr = Array.isArray(jsonLd.employmentType)
        ? jsonLd.employmentType[0]
        : jsonLd.employmentType || null;
      experienceStr = jsonLd.experienceRequirements?.monthsOfExperience
        ? `${Math.round(jsonLd.experienceRequirements.monthsOfExperience / 12)} years`
        : null;
      if (jsonLd.baseSalary) {
        const val = jsonLd.baseSalary.value;
        if (val?.minValue && val?.maxValue) {
          salaryStr = `${jsonLd.baseSalary.currency || "AED"} ${val.minValue} - ${val.maxValue}`;
        }
      }
      postedAt = jsonLd.datePosted || null;
      if (jsonLd.qualifications) {
        reqQuals.push(jsonLd.qualifications);
      }
    }

    // Fall back to DOM selectors for anything missing
    if (!title) {
      title = await page
        .locator("h1.info-position")
        .first()
        .textContent()
        .then((t) => t.split("\n")[0].trim())
        .catch(() => null);
    }

    if (company === "Not Mentioned") {
      company = await page
        .locator("p.info-org")
        .first()
        .textContent()
        .then((t) => t.trim())
        .catch(() => "Not Mentioned");
    }

    // Extract candidate requirements from DOM
    const requirements = {};
    const blocks = await page.locator(".candidate-profile .col").all();
    for (const block of blocks) {
      try {
        const head = await block.locator(".head").textContent();
        const value = await block.locator(".value").textContent();
        requirements[head.toLowerCase().replace(/\s+/g, "_")] = value.trim();
      } catch {
        // skip malformed blocks
      }
    }

    if (!location) {
      location = requirements.location || null;
    }
    if (!salaryStr && requirements.salary) {
      salaryStr = requirements.salary;
    }
    if (!experienceStr && requirements.experience) {
      experienceStr = requirements.experience;
    }
    if (!jobTypeStr) {
      jobTypeStr =
        requirements.job_type || requirements.employment_type || null;
    }
    if (requirements.education) {
      reqQuals.push(requirements.education);
    }

    // Full description HTML from DOM if not from JSON-LD
    if (!descriptionHtml) {
      descriptionHtml = await page
        .locator("article.job-description")
        .first()
        .innerHTML()
        .catch(() => "");
    }

    // Company website from external application link
    if (!companyWebsite) {
      companyWebsite = await page
        .locator(".jd-company-desc a.anchor.ng-link")
        .first()
        .getAttribute("href", { timeout: 5000 })
        .then((href) => {
          try {
            return new URL(href).origin;
          } catch {
            return null;
          }
        })
        .catch(() => null);
    }

    const salary = parseSalary(salaryStr);
    const urlPath = url.split("/").filter(Boolean).pop() || url;

    // Parse structured fields from description HTML
    const parsed = parseDescription(descriptionHtml);

    // Derive country_code from JSON-LD address or location text
    const addressCountry = jsonLd?.jobLocation?.address?.addressCountry || null;
    const country_code = parseCountryCode(addressCountry) || parseCountryCode(location) || "AE";

    // Detect remote from location/job type text
    const locationLower = (location || "").toLowerCase();
    const is_remote =
      locationLower.includes("remote") ||
      locationLower.includes("work from home") ||
      (jsonLd?.jobLocationType || "").toUpperCase() === "TELECOMMUTE";

    // Salary: structured > parsed from description
    const salary_min = salary.min || (parsed.salary ? parsed.salary.min : null);
    const salary_max = salary.max || (parsed.salary ? parsed.salary.max : null);
    const salary_currency = salary.currency || (parsed.salary ? parsed.salary.currency : null);

    return {
      title,
      source_url: url,
      description: descriptionHtml,
      posted_at: postedAt,
      external_job_id: urlPath,
      external_source: "NaukriGulf",
      source_type: "SCRAPER",
      source_base_url: BASE_URL,
      is_remote,
      location,
      country_code,
      job_type: mapJobType(jobTypeStr) || parsed.job_type || null,
      experience_level: parseExperienceToLevel(experienceStr) || parseExperienceLevelFromTitle(title) || parsed.experience_level || null,
      salary_min,
      salary_max,
      salary_currency,
      skills: parsed.skills.length > 0 ? parsed.skills : [],
      requirements: parsed.requirements.length > 0 ? parsed.requirements : [],
      responsibilities: parsed.responsibilities.length > 0 ? parsed.responsibilities : [],
      benefits: parsed.benefits.length > 0 ? parsed.benefits : [],
      summary: parsed.summary || null,
      highlights: parsed.highlights.length > 0 ? parsed.highlights : [],
      required_qualifications: reqQuals.length > 0 ? reqQuals : (parsed.required_qualifications.length > 0 ? parsed.required_qualifications : []),
      preferred_qualifications: parsed.preferred_qualifications.length > 0 ? parsed.preferred_qualifications : [],
      visa_sponsorship: parsed.visa_sponsorship || false,
      categories: [],
      company: {
        name: company,
        website: companyWebsite,
        location,
        country_code,
      },
    };
  } finally {
    await page.close();
  }
}

async function scrapeNaukriGulf() {
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
    });

    const listingPage = await context.newPage();
    const allJobUrls = [];
    let currentUrl = START_URL;

    // Pagination: collect job URLs from listing pages
    while (currentUrl && allJobUrls.length < MAX_JOBS) {
      await listingPage.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await listingPage.waitForTimeout(3000);

      // Wait for job cards
      try {
        await listingPage.waitForSelector(".ng-box.srp-tuple", {
          timeout: 10000,
        });
      } catch {
        console.warn(
          `NaukriGulf: No job cards found on ${currentUrl}, stopping pagination`
        );
        break;
      }

      // Extract job URLs from this page
      const pageUrls = await listingPage.evaluate(() => {
        const cards = document.querySelectorAll(".ng-box.srp-tuple");
        const urls = [];
        for (const card of cards) {
          // Skip easy-apply jobs
          const easyApply = card.querySelector(
            "span:not([class])"
          );
          if (easyApply && easyApply.textContent.includes("Easy Apply")) {
            continue;
          }
          const link = card.querySelector("a.info-position");
          if (link?.href) {
            urls.push(link.href);
          }
        }
        return urls;
      });

      for (const u of pageUrls) {
        if (allJobUrls.length >= MAX_JOBS) break;
        if (!allJobUrls.includes(u)) {
          allJobUrls.push(u);
        }
      }

      console.log(
        `NaukriGulf: Collected ${allJobUrls.length} job URLs so far`
      );

      // Follow "Next" link
      currentUrl = await listingPage
        .locator("a[aria-label='Next']")
        .first()
        .getAttribute("href", { timeout: 5000 })
        .then((href) => {
          if (!href) return null;
          return href.startsWith("http") ? href : `${BASE_URL}${href}`;
        })
        .catch(() => null);
    }

    await listingPage.close();
    console.log(
      `NaukriGulf: Total job URLs to scrape: ${allJobUrls.length}`
    );

    // Scrape detail pages sequentially (stealth plugin conflicts with parallel page opens)
    const results = [];
    for (let i = 0; i < allJobUrls.length; i++) {
      const url = allJobUrls[i];
      console.log(
        `NaukriGulf: Detail page ${i + 1}/${allJobUrls.length}`
      );

      try {
        const job = await scrapeDetailPage(context, url);
        if (job?.title) {
          results.push(job);
        } else {
          console.warn(`NaukriGulf: No title extracted for ${url}, skipping`);
        }
      } catch (err) {
        console.warn(`NaukriGulf: Failed to scrape ${url}: ${err.message}`);
      }

      // Delay between pages to avoid rate limiting
      if (i + 1 < allJobUrls.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    console.log(`NaukriGulf: Scraped ${results.length} jobs total`);
    return results;
  } finally {
    await browser.close();
  }
}

module.exports = scrapeNaukriGulf;
