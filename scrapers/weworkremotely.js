const axios = require("axios");
const xml2js = require("xml2js");
const cheerio = require("cheerio");
const playwright = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require("user-agents");
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseCountryCode,
  parseSalaryText,
} = require("../lib/descriptionParser");

playwright.chromium.use(StealthPlugin());

const FEED_URLS = [
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
];

const DETAIL_BATCH_SIZE = 5;
const DETAIL_PAGE_TIMEOUT = 15000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDetailPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: DETAIL_PAGE_TIMEOUT,
    });

    const detail = await page.evaluate(() => {
      const result = {};

      // --- JSON-LD structured data (most reliable source) ---
      const jsonLdEl = document.querySelector(
        'script[type="application/ld+json"]'
      );
      if (jsonLdEl) {
        try {
          const ld = JSON.parse(jsonLdEl.textContent);
          if (ld["@type"] === "JobPosting") {
            result.jsonLd = {
              title: ld.title,
              employmentType: ld.employmentType,
              datePosted: ld.datePosted,
              validThrough: ld.validThrough,
              directApply: ld.directApply,
              occupationalCategory: ld.occupationalCategory,
              url: ld.url,
            };

            // Salary from JSON-LD
            if (ld.baseSalary && ld.baseSalary.value) {
              const min = parseFloat(ld.baseSalary.value.minValue);
              const max = parseFloat(ld.baseSalary.value.maxValue);
              if (min > 0 || max > 0) {
                result.salary_min = min || null;
                result.salary_max = max || null;
                result.salary_currency = ld.baseSalary.currency || "USD";
              }
            }

            // Hiring organization
            if (ld.hiringOrganization) {
              result.company_name = ld.hiringOrganization.name;
              result.company_location =
                ld.hiringOrganization.address || null;
              result.company_logo = ld.hiringOrganization.logo || null;
            }
          }
        } catch (e) {
          // ignore JSON parse errors
        }
      }

      // --- Main description HTML from new page structure ---
      // Current WWR layout: .lis-container__job__content__description
      const descContainer = document.querySelector(
        ".lis-container__job__content__description"
      );
      // Fallback to legacy selectors
      const listingBody =
        descContainer ||
        document.querySelector(".listing-container") ||
        document.querySelector(".listing-body") ||
        document.querySelector("article");

      if (listingBody) {
        result.description = listingBody.innerHTML.trim();
      }

      // --- Sidebar structured data ---
      const sidebarItems = document.querySelectorAll(
        ".lis-container__job__sidebar li"
      );
      for (const li of sidebarItems) {
        const text = li.innerText.trim();
        if (text.startsWith("Job type")) {
          result.job_type_text = text.replace("Job type", "").trim();
        } else if (text.startsWith("Region")) {
          result.region = text.replace("Region", "").trim();
        } else if (text.startsWith("Salary")) {
          result.salary_text = text.replace("Salary", "").trim();
        } else if (text.startsWith("Apply before")) {
          result.apply_before = text.replace("Apply before", "").trim();
        }
      }

      // --- Company details from sidebar ---
      const sidebarEl = document.querySelector(
        ".lis-container__job__sidebar"
      );
      if (sidebarEl) {
        // Company logo — skip the default WWR placeholder
        const logo = sidebarEl.querySelector("img");
        if (logo && !result.company_logo) {
          const src = logo.src || "";
          const isPlaceholder =
            src.includes("company-name-new-listing-icon") ||
            src.includes("placeholder");
          if (!isPlaceholder) {
            result.company_logo = src;
          }
        }

        // External company website
        const website = sidebarEl.querySelector(
          "a[href^='http']:not([href*='weworkremotely'])"
        );
        if (website) result.company_website = website.href;

        // Company profile URL on WWR
        const profileLink = sidebarEl.querySelector(
          "a[href*='/company/']"
        );
        if (profileLink) {
          result.company_profile_url = profileLink.href;
        }

        // Company name from sidebar heading
        const companyHeading = sidebarEl.querySelector("h2, h3, h4");
        if (companyHeading && !result.company_name) {
          result.company_name = companyHeading.innerText.trim();
        }
      }

      // --- Company description from job listing body ---
      // Many job posts include "About Us" / "About the Company" sections
      const descEl = document.querySelector(
        ".lis-container__job__content__description"
      );
      if (descEl) {
        const descText = descEl.innerText;
        const aboutPatterns = [
          /(?:About (?:Us|the Company|Our Company))[:\s]*\n([\s\S]{30,800}?)(?:\n\n\n|\n[A-Z][a-z]+ [A-Z])/i,
          /(?:Who (?:We Are|we are))[:\s]*\n([\s\S]{30,800}?)(?:\n\n\n|\n[A-Z][a-z]+ [A-Z])/i,
          /(?:Company (?:Overview|Description))[:\s]*\n([\s\S]{30,800}?)(?:\n\n\n|\n[A-Z][a-z]+ [A-Z])/i,
        ];
        for (const p of aboutPatterns) {
          const m = descText.match(p);
          if (m) {
            result.company_description = m[1]
              .replace(/\n+/g, " ")
              .trim()
              .substring(0, 500);
            break;
          }
        }
      }

      // --- Application URL ---
      const applyLink = document.querySelector(
        "a[href*='apply'], a.apply-button, a.apply-btn, a[class*='apply']"
      );
      if (applyLink) {
        result.apply_url = applyLink.href;
      }

      return result;
    });

    return detail;
  } catch (err) {
    console.warn(`Failed to fetch WWR detail page ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

function resolveLocation(regionText) {
  if (!regionText) return "Remote";
  const r = regionText.toLowerCase().trim();
  if (
    /anywhere in the world/i.test(r) ||
    /worldwide/i.test(r) ||
    /global/i.test(r)
  )
    return "Remote (Worldwide)";
  if (/\bus only\b/i.test(r) || r === "us" || r === "usa")
    return "Remote (US)";
  if (/\beurope only\b/i.test(r) || /\beu only\b/i.test(r))
    return "Remote (Europe)";
  if (/\buk only\b/i.test(r)) return "Remote (UK)";
  if (/\bcanada only\b/i.test(r)) return "Remote (Canada)";
  if (/\blatam\b/i.test(r) || /latin america/i.test(r))
    return "Remote (LATAM)";
  if (/\bapac\b/i.test(r) || /asia.pacific/i.test(r))
    return "Remote (APAC)";
  return regionText.trim();
}

function parseJobType(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("full")) return "FULL_TIME";
  if (t.includes("part")) return "PART_TIME";
  if (t.includes("contract")) return "CONTRACT";
  if (t.includes("freelance")) return "FREELANCE";
  return null;
}

async function scrapeWeWorkRemotely() {
  // Step 1: Fetch all RSS feeds (no browser needed)
  const parser = new xml2js.Parser({ explicitArray: false });
  const seenLinks = new Set();
  const allRssItems = [];

  for (const feedUrl of FEED_URLS) {
    try {
      const response = await axios.get(feedUrl, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const parsed = await parser.parseStringPromise(response.data);
      const items = parsed.rss.channel.item;
      const feedItems = Array.isArray(items) ? items : items ? [items] : [];

      let added = 0;
      for (const item of feedItems) {
        const urlPath = (item.link || "")
          .split("/")
          .filter(Boolean)
          .pop() || item.link;
        if (!seenLinks.has(urlPath)) {
          seenLinks.add(urlPath);
          allRssItems.push(item);
          added++;
        }
      }
      console.log(
        `  Feed ${feedUrl.split("/").pop()}: ${feedItems.length} items (${added} new, ${feedItems.length - added} duplicates)`
      );
    } catch (err) {
      console.warn(`  Failed to fetch feed ${feedUrl}: ${err.message}`);
    }
  }

  const rssItems = allRssItems;
  console.log(
    `Fetched ${rssItems.length} unique RSS items from WeWorkRemotely, fetching detail pages...`
  );

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
      console.log(
        `  Detail pages: ${Math.min(i + DETAIL_BATCH_SIZE, rssItems.length)}/${rssItems.length}`
      );
    }

    const jobs = rssItems.map((item, idx) => {
      const rawTitle = item.title || "";
      const companyFromCreator = item["dc:creator"] || null;
      const detail = detailResults[idx];

      // WWR titles are formatted as "Company: Job Title"
      let companyName = companyFromCreator;
      let cleanTitle = rawTitle;
      if (!companyName && rawTitle.includes(": ")) {
        const colonIdx = rawTitle.indexOf(": ");
        companyName = rawTitle.substring(0, colonIdx).trim();
        cleanTitle = rawTitle.substring(colonIdx + 2).trim();
      }

      // Prefer company name from JSON-LD
      if (detail?.company_name) {
        companyName = detail.company_name;
      }

      // Parse RSS HTML description for fallback data
      const $ = cheerio.load(item.description || "");
      const rssLogoImg = $("img").first().attr("src") || null;

      let companyLocation = null;
      $("li").each((_, li) => {
        const text = $(li).text();
        if (/headquarters/i.test(text)) {
          companyLocation = text.replace(/headquarters:?\s*/i, "").trim();
        }
      });

      let companyWebsite = null;
      $("a").each((_, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text() || "";
        if (
          /apply|company|website/i.test(text) &&
          href.startsWith("http")
        ) {
          companyWebsite = href;
        }
      });
      if (!companyWebsite) {
        const firstLink = $("a").first().attr("href") || "";
        if (
          firstLink.startsWith("http") &&
          !firstLink.includes("weworkremotely.com")
        ) {
          companyWebsite = firstLink;
        }
      }

      const rssState = item.state || null;

      // Use detail page description (full HTML), fall back to RSS
      const descriptionHtml = detail?.description || item.description;

      // Parse the description HTML using shared parser for structured extraction
      const parsed = parseDescription(descriptionHtml);

      // Region/location: prefer sidebar, then RSS
      const regionText =
        detail?.region || item.region || null;
      const location =
        resolveLocation(regionText) || companyLocation || "Remote";
      const country_code =
        parseCountryCode(
          item.country ||
            regionText ||
            detail?.company_location ||
            companyLocation
        ) || null;

      // Job type: sidebar > JSON-LD > RSS > parsed from description
      const job_type =
        parseJobType(detail?.job_type_text) ||
        parseJobType(detail?.jsonLd?.employmentType) ||
        parseJobType(item.type) ||
        parsed.job_type ||
        null;

      // Experience level from title, then from parsed description
      const experience_level =
        parseExperienceLevelFromTitle(cleanTitle) ||
        parsed.experience_level ||
        null;

      // Salary: detail page sidebar text > JSON-LD > parsed from description > RSS fallback
      let salary_min = null;
      let salary_max = null;
      let salary_currency = null;

      // Try sidebar salary text first
      if (detail?.salary_text) {
        const salaryParsed = parseSalaryText(detail.salary_text);
        if (salaryParsed) {
          salary_min = salaryParsed.min;
          salary_max = salaryParsed.max;
          salary_currency = salaryParsed.currency;
        }
      }

      // Then JSON-LD
      if (!salary_min && detail?.salary_min) {
        salary_min = detail.salary_min;
        salary_max = detail.salary_max;
        salary_currency = detail.salary_currency;
      }

      // Then parsed from description HTML
      if (!salary_min && parsed.salary) {
        salary_min = parsed.salary.min;
        salary_max = parsed.salary.max;
        salary_currency = parsed.salary.currency;
      }

      // Final fallback: regex on RSS plain text
      if (!salary_min) {
        const plainText = $.text();
        const salaryMatch = plainText.match(
          /\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/
        );
        if (salaryMatch) {
          salary_min = parseInt(salaryMatch[1].replace(/,/g, ""), 10);
          salary_max = parseInt(salaryMatch[2].replace(/,/g, ""), 10);
          salary_currency = "USD";
        }
      }

      // Skills: merge RSS skills + parsed skills (deduplicated)
      const rssSkills = item.skills
        ? item.skills
            .split(/,\s*and\s*|,\s*|\s+and\s+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const combinedSkills = [
        ...new Set([...rssSkills, ...parsed.skills]),
      ];

      // Application deadline from sidebar
      let application_deadline = null;
      if (detail?.apply_before) {
        try {
          const d = new Date(detail.apply_before);
          if (!isNaN(d.getTime())) application_deadline = d.toISOString();
        } catch (e) {
          // ignore
        }
      }
      if (!application_deadline && detail?.jsonLd?.validThrough) {
        try {
          const d = new Date(detail.jsonLd.validThrough);
          if (!isNaN(d.getTime())) application_deadline = d.toISOString();
        } catch (e) {
          // ignore
        }
      }

      const urlPath = (item.link || "")
        .split("/")
        .filter(Boolean)
        .pop() || item.link;

      return {
        title: cleanTitle,
        source_url: item.link,
        description: descriptionHtml,
        posted_at: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : null,
        external_job_id: urlPath,
        external_source: "WeWorkRemotely",
        source_type: "RSS",
        source_base_url: "https://weworkremotely.com",
        is_remote: true,
        location,
        country_code,
        salary_min,
        salary_max,
        salary_currency,
        job_type,
        experience_level,
        visa_sponsorship: parsed.visa_sponsorship || false,
        skills: combinedSkills.length > 0 ? combinedSkills : [],
        requirements: parsed.requirements.length > 0 ? parsed.requirements : [],
        responsibilities:
          parsed.responsibilities.length > 0 ? parsed.responsibilities : [],
        benefits: parsed.benefits.length > 0 ? parsed.benefits : [],
        summary: parsed.summary || null,
        highlights:
          parsed.highlights.length > 0 ? parsed.highlights : [],
        required_qualifications:
          parsed.required_qualifications.length > 0
            ? parsed.required_qualifications
            : [],
        preferred_qualifications:
          parsed.preferred_qualifications.length > 0
            ? parsed.preferred_qualifications
            : [],
        application_deadline,
        company: {
          name: companyName,
          logo_url: detail?.company_logo || rssLogoImg,
          website: detail?.company_website || companyWebsite,
          location: detail?.company_location || companyLocation || rssState || null,
          description: detail?.company_description || null,
          profile_url: detail?.company_profile_url || null,
        },
        categories: [],
      };
    });

    console.log(
      `Scraped ${jobs.length} jobs from WeWorkRemotely (with detail pages)`
    );
    return jobs;
  } catch (err) {
    console.error(
      "Error scraping WeWorkRemotely detail pages:",
      err.message
    );
    // Fall back to RSS-only data
    return rssItems.map((item) => {
      const rawTitle = item.title || "";
      const companyFromCreator = item["dc:creator"] || null;
      let companyName = companyFromCreator;
      let cleanTitle = rawTitle;
      if (!companyName && rawTitle.includes(": ")) {
        const colonIdx = rawTitle.indexOf(": ");
        companyName = rawTitle.substring(0, colonIdx).trim();
        cleanTitle = rawTitle.substring(colonIdx + 2).trim();
      }
      const urlPath = (item.link || "")
        .split("/")
        .filter(Boolean)
        .pop() || item.link;
      return {
        title: cleanTitle,
        source_url: item.link,
        description: item.description,
        posted_at: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : null,
        external_job_id: urlPath,
        external_source: "WeWorkRemotely",
        source_type: "RSS",
        source_base_url: "https://weworkremotely.com",
        is_remote: true,
        location: "Remote",
        country_code: null,
        company: { name: companyName },
        categories: [],
      };
    });
  } finally {
    await browser.close();
  }
}

module.exports = scrapeWeWorkRemotely;
