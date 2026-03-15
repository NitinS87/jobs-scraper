const { chromium } = require("playwright");

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

    const jobs = rawJobs.map((job) => {
      const urlPath = (job.job_url || "").split("/").filter(Boolean).pop() || job.job_url;

      return {
        title: job.title,
        source_url: job.job_url,
        description: "", // Could navigate to detail pages for richer data
        posted_at: null,
        external_job_id: urlPath,
        external_source: "TokyoDev",
        source_type: "SCRAPER",
        source_base_url: "https://www.tokyodev.com",
        is_remote: job.is_remote,
        location: job.location,
        country_code: "JP",
        categories: [],
        company: {
          name: job.company,
          country_code: "JP",
        },
      };
    });

    console.log(`Scraped ${jobs.length} jobs from TokyoDev`);
    return jobs;
  } catch (err) {
    console.error("Error scraping TokyoDev:", err.message);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = scrapeTokyoDev;
