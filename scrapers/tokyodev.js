const { chromium } = require("playwright");

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

      // Salary info
      const salaryMatch = text.match(/(?:Salary|Compensation|Pay)[:\s]*([¥$€]\s?[\d,]+(?:\s*[-–—to]+\s*[¥$€]?\s*[\d,]+)?)/i);
      if (salaryMatch) {
        result.salary_text = salaryMatch[1].trim();
      }

      // Visa sponsorship
      if (/visa\s*(?:sponsor|support)/i.test(text)) {
        result.visa_sponsorship = true;
      }

      // Job type
      if (/\bfull[- ]?time\b/i.test(text)) result.job_type = "FULL_TIME";
      else if (/\bpart[- ]?time\b/i.test(text)) result.job_type = "PART_TIME";
      else if (/\bcontract\b/i.test(text)) result.job_type = "CONTRACT";

      // Posted date
      const dateEl = document.querySelector("time[datetime]");
      if (dateEl) {
        result.posted_at = dateEl.getAttribute("datetime");
      }

      // Tags/categories
      const tags = [];
      document.querySelectorAll("a.tag, [class*='tag']").forEach((tag) => {
        const t = tag.innerText.trim();
        if (t && t.length < 50) tags.push(t);
      });
      if (tags.length) result.tags = tags;

      return result;
    });

    return detail;
  } catch (err) {
    console.warn(`Failed to fetch TokyoDev detail page ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeTokyoDev() {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
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

          const tags = jobItem.querySelectorAll("a.tag");
          tags.forEach((tag) => {
            const text = tag.innerText.trim().toLowerCase();
            if (text.includes("remote")) {
              location = tag.innerText.trim();
              is_remote = true;
            }
          });

          results.push({
            title,
            company,
            location,
            job_url,
            is_remote,
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

      const posted_at = detail?.posted_at
        ? new Date(detail.posted_at).toISOString()
        : null;

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
        categories: detail?.tags || [],
        company: {
          name: job.company,
          country_code: "JP",
        },
      };

      if (detail?.job_type) result.job_type = detail.job_type;
      if (detail?.visa_sponsorship) result.visa_sponsorship = true;
      if (detail?.salary_text) result.salary_text = detail.salary_text;

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
