const playwright = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require("user-agents");
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  parseSalaryText,
} = require("../lib/descriptionParser");

playwright.chromium.use(StealthPlugin());

const DETAIL_BATCH_SIZE = 5;
const DETAIL_PAGE_TIMEOUT = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCloudflareChallenge(html) {
  if (!html) return false;
  return (
    html.includes("challenge-error-text") ||
    html.includes("Enable JavaScript and cookies to continue") ||
    html.includes("cf-challenge") ||
    html.includes("cf-browser-verification") ||
    html.includes("Just a moment...") ||
    html.includes("Checking your browser")
  );
}

async function fetchDetailPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: "load",
      timeout: DETAIL_PAGE_TIMEOUT,
    });

    // Wait for actual content to render (article or main content area)
    await page
      .waitForSelector("article, [class*='description'], [class*='content'], main", {
        timeout: 10000,
      })
      .catch(() => {});

    const detail = await page.evaluate(() => {
      const result = {};

      // Full job description — main content area
      const descEl = document.querySelector("article") ||
        document.querySelector("[class*='description']") ||
        document.querySelector("[class*='content']") ||
        document.querySelector("main");
      if (descEl) {
        result.description = descEl.innerHTML.trim();
      }

      // Extract structured data from the page
      const text = document.body.innerText;

      // Salary info — check dedicated sections first, then regex patterns
      const salarySection = document.querySelector(
        "[class*='salary'], [class*='compensation'], " +
        "dt:has(+ dd):where(:is([class*='salary'], [class*='comp']))"
      );
      // Also look for dt/dd pairs with salary/compensation labels
      const dtElements = document.querySelectorAll("dt");
      let salaryDdText = null;
      for (const dt of dtElements) {
        const dtText = dt.innerText.trim().toLowerCase();
        if (dtText.includes("salary") || dtText.includes("compensation") || dtText.includes("pay")) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === "DD") {
            salaryDdText = dd.innerText.trim();
            break;
          }
        }
      }

      if (salarySection) {
        result.salary_text = salarySection.innerText.trim();
      } else if (salaryDdText) {
        result.salary_text = salaryDdText;
      } else {
        // Try multiple salary patterns
        const salaryPatterns = [
          // ¥7,000,000 - ¥15,000,000
          /[¥￥]\s?[\d,]+(?:\s*[-–—~to]+\s*[¥￥]?\s*[\d,]+)/,
          // 7M - 15M JPY or ¥7M-15M
          /[¥￥]?\s?\d+(?:\.\d+)?M\s*[-–—~to]+\s*[¥￥]?\s?\d+(?:\.\d+)?M(?:\s*JPY)?/i,
          // 7,000,000 - 15,000,000 JPY
          /[\d,]+\s*[-–—~to]+\s*[\d,]+\s*JPY/i,
          // Patterns with 万 (man/10k) units: 700万 - 1500万
          /[\d,]+万\s*[-–—~to円]+\s*[\d,]+万(?:\s*円)?/,
          // Generic salary/compensation line with currency
          /(?:Salary|Compensation|Pay)[:\s]*([¥$€￥]\s?[\d,]+(?:\s*[-–—~to]+\s*[¥$€￥]?\s*[\d,]+)?(?:\s*(?:JPY|USD|EUR))?)/i,
          // Standalone JPY amounts
          /(?:JPY|¥|￥)\s?[\d,]+(?:k|K)?(?:\s*[-–—~to]+\s*(?:JPY|¥|￥)?\s?[\d,]+(?:k|K)?)?/,
        ];

        for (const pattern of salaryPatterns) {
          const match = text.match(pattern);
          if (match) {
            result.salary_text = (match[1] || match[0]).trim();
            break;
          }
        }
      }

      // Visa sponsorship
      if (/visa\s*(?:sponsor|support)/i.test(text)) {
        result.visa_sponsorship = true;
      }

      // Job type — check JSON-LD first, then structured metadata, then text
      try {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScripts) {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item["@type"] === "JobPosting" && item.employmentType) {
              const empType = Array.isArray(item.employmentType) ? item.employmentType[0] : item.employmentType;
              const normalized = empType.toUpperCase().replace(/[-\s]+/g, "_");
              if (["FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY", "INTERNSHIP"].includes(normalized)) {
                result.job_type = normalized;
              }
            }
          }
        }
      } catch (_) { /* ignore JSON parse errors */ }

      // Check structured dt/dd metadata for job type
      if (!result.job_type) {
        for (const dt of dtElements) {
          const dtText = dt.innerText.trim().toLowerCase();
          if (dtText.includes("type") || dtText.includes("employment")) {
            const dd = dt.nextElementSibling;
            if (dd && dd.tagName === "DD") {
              const ddText = dd.innerText.trim().toLowerCase();
              if (/\bfull[- ]?time\b/.test(ddText)) result.job_type = "FULL_TIME";
              else if (/\bpart[- ]?time\b/.test(ddText)) result.job_type = "PART_TIME";
              else if (/\bcontract\b/.test(ddText)) result.job_type = "CONTRACT";
              break;
            }
          }
        }
      }

      // Fallback: text-based detection
      if (!result.job_type) {
        if (/\bfull[- ]?time\b/i.test(text)) result.job_type = "FULL_TIME";
        else if (/\bpart[- ]?time\b/i.test(text)) result.job_type = "PART_TIME";
        else if (/\bcontract\b/i.test(text)) result.job_type = "CONTRACT";
      }

      // Posted date — try multiple sources in priority order
      const dateEl = document.querySelector("time[datetime]");
      if (dateEl) {
        result.posted_at = dateEl.getAttribute("datetime");
      }

      if (!result.posted_at) {
        const metaDate = document.querySelector('meta[property="article:published_time"]');
        if (metaDate) {
          result.posted_at = metaDate.getAttribute("content");
        }
      }

      if (!result.posted_at) {
        try {
          const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of ldScripts) {
            const data = JSON.parse(script.textContent);
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              if (item["@type"] === "JobPosting" && item.datePosted) {
                result.posted_at = item.datePosted;
                break;
              }
            }
            if (result.posted_at) break;
          }
        } catch (_) { /* ignore JSON parse errors */ }
      }

      if (!result.posted_at) {
        const postedMatch = text.match(/Posted\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4}|\d{4}[-/]\d{2}[-/]\d{2})/i);
        if (postedMatch) {
          const parsed = new Date(postedMatch[1]);
          if (!isNaN(parsed.getTime())) {
            result.posted_at = parsed.toISOString();
          }
        }
      }

      // Company details — look for "About" section and company website
      let companyDescription = null;
      let companyWebsite = null;

      // Find "About" or "About the company" sections
      const headings = document.querySelectorAll("h2, h3, h4");
      for (const heading of headings) {
        const hText = heading.innerText.trim().toLowerCase();
        if (hText.includes("about") && (hText.includes("company") || hText === "about" || hText.includes("about us"))) {
          // Grab the text content following this heading until the next heading
          let content = [];
          let sibling = heading.nextElementSibling;
          while (sibling && !["H2", "H3", "H4"].includes(sibling.tagName)) {
            const t = sibling.innerText.trim();
            if (t) content.push(t);
            sibling = sibling.nextElementSibling;
          }
          if (content.length) {
            companyDescription = content.join("\n").substring(0, 2000);
          }
          break;
        }
      }
      if (companyDescription) result.company_description = companyDescription;

      // Look for company website — external links not pointing to tokyodev.com
      const allLinks = document.querySelectorAll("a[href]");
      for (const link of allLinks) {
        const href = link.getAttribute("href");
        const linkText = link.innerText.trim().toLowerCase();
        if (
          href &&
          href.startsWith("http") &&
          !href.includes("tokyodev.com") &&
          !href.includes("twitter.com") &&
          !href.includes("linkedin.com") &&
          !href.includes("github.com") &&
          !href.includes("facebook.com") &&
          (linkText.includes("website") || linkText.includes("homepage") || linkText.includes("company site") ||
           link.closest("[class*='company']") || link.closest("[class*='about']"))
        ) {
          companyWebsite = href;
          break;
        }
      }
      if (companyWebsite) result.company_website = companyWebsite;

      // Tags/categories
      const tags = [];
      document.querySelectorAll("a.tag, [class*='tag']").forEach((tag) => {
        const t = tag.innerText.trim();
        if (t && t.length < 50) tags.push(t);
      });
      if (tags.length) result.tags = tags;

      return result;
    });

    // Detect Cloudflare challenge pages and discard
    if (detail?.description && isCloudflareChallenge(detail.description)) {
      console.warn(`Cloudflare challenge detected on ${url}, discarding description`);
      delete detail.description;
    }

    return detail;
  } catch (err) {
    console.warn(`Failed to fetch TokyoDev detail page ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeTokyoDev() {
  const browser = await playwright.chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent: new UserAgent().toString(),
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "Asia/Tokyo",
  });

  const page = await context.newPage();

  try {
    await page.goto("https://www.tokyodev.com/jobs", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForSelector("div.flex-1", { timeout: 60000 });

    const rawJobs = await page.evaluate(() => {
      const results = [];
      const companyBlocks = document.querySelectorAll("div.flex-1");

      companyBlocks.forEach((companyBlock) => {
        const companyLink = companyBlock.querySelector("h3 a[href^='/companies/']");
        if (!companyLink) return;

        const company = companyLink.innerText.trim();

        const jobItems = companyBlock.querySelectorAll(
          "div[data-collapsable-list-target='item']"
        );

        jobItems.forEach((jobItem) => {
          const titleLink = jobItem.querySelector("a.font-bold[href*='/jobs/']");
          if (!titleLink) return;

          const title = titleLink.innerText.trim();
          const job_url = titleLink.href;

          let location = null;
          let is_remote = false;

          let job_type = null;
          const tags = jobItem.querySelectorAll("a.tag");
          tags.forEach((tag) => {
            const text = tag.innerText.trim().toLowerCase();
            if (text.includes("remote")) {
              location = tag.innerText.trim();
              is_remote = true;
            }
            if (/\bfull[- ]?time\b/.test(text)) job_type = "FULL_TIME";
            else if (/\bpart[- ]?time\b/.test(text)) job_type = "PART_TIME";
            else if (/\bcontract\b/.test(text)) job_type = "CONTRACT";
            else if (/\bfreelance\b/.test(text)) job_type = "CONTRACT";
            else if (/\bintern\b/.test(text)) job_type = "INTERNSHIP";
          });

          results.push({
            title,
            company,
            location,
            job_url,
            is_remote,
            job_type,
          });
        });
      });

      return results;
    });

    console.log(`Found ${rawJobs.length} listings from TokyoDev, fetching detail pages...`);

    // Close listing page to free memory
    await page.close();

    // Fetch detail pages in batches
    const detailResults = [];
    for (let i = 0; i < rawJobs.length; i += DETAIL_BATCH_SIZE) {
      const batch = rawJobs.slice(i, i + DETAIL_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((job) => fetchDetailPage(context, job.job_url))
      );
      detailResults.push(...batchResults);

      if (i + DETAIL_BATCH_SIZE < rawJobs.length) {
        // Random delay between batches (500ms-1s)
        await delay(500 + Math.random() * 500);
      }
      console.log(`  Detail pages: ${Math.min(i + DETAIL_BATCH_SIZE, rawJobs.length)}/${rawJobs.length}`);
    }

    const jobs = rawJobs.map((job, idx) => {
      const urlPath = (job.job_url || "").split("/").filter(Boolean).pop() || job.job_url;
      const detail = detailResults[idx];

      // Clean up location text
      let location = job.location || "Japan";
      if (location === "No remote") location = "Japan (On-site)";
      else if (location === "Fully remote") location = "Japan (Remote)";
      else if (location === "Partially remote") location = "Japan (Hybrid)";

      // Use detail page description or fallback to placeholder
      const description = detail?.description ||
        `${job.title} at ${job.company}. Location: ${location}. View full details at ${job.job_url}`;

      // Parse structured fields from description HTML
      const parsed = parseDescription(description);

      const posted_at = detail?.posted_at
        ? new Date(detail.posted_at).toISOString()
        : null;

      // Salary: parse from salary_text, then from description
      let salary_min = null;
      let salary_max = null;
      let salary_currency = null;
      if (detail?.salary_text) {
        const salaryParsed = parseSalaryText(detail.salary_text);
        if (salaryParsed) {
          salary_min = salaryParsed.min;
          salary_max = salaryParsed.max;
          salary_currency = salaryParsed.currency;
        }
      }
      if (!salary_min && parsed.salary) {
        salary_min = parsed.salary.min;
        salary_max = parsed.salary.max;
        salary_currency = parsed.salary.currency;
      }

      const result = {
        title: job.title,
        source_url: job.job_url,
        description,
        posted_at,
        external_job_id: urlPath,
        external_source: "TokyoDev",
        source_type: "SCRAPER",
        source_base_url: "https://www.tokyodev.com",
        is_remote: job.is_remote,
        location,
        country_code: "JP",
        job_type: detail?.job_type || job.job_type || parsed.job_type || null,
        experience_level: parseExperienceLevelFromTitle(job.title) || parsed.experience_level || null,
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
        visa_sponsorship: detail?.visa_sponsorship || parsed.visa_sponsorship || false,
        categories: detail?.tags || [],
        company: {
          name: job.company,
          country_code: "JP",
          ...(detail?.company_description && { description: detail.company_description }),
          ...(detail?.company_website && { website: detail.company_website }),
        },
      };

      return result;
    });

    console.log(`Scraped ${jobs.length} jobs from TokyoDev (with detail pages)`);
    return jobs;
  } catch (err) {
    console.error("Error scraping TokyoDev:", err.message);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = scrapeTokyoDev;
