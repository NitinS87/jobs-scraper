const playwright = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require("user-agents");

playwright.chromium.use(StealthPlugin());

const START_URL =
  "https://jobsinjapan.com/?s=software&location=&type=&_noo_job_field_english_level=&_noo_job_field_japanese_level=&_noo_job_field_employer_type=&post_type=noo_job";

const randomDelay = (min = 1000, max = 2500) =>
  new Promise((res) =>
    setTimeout(res, Math.floor(Math.random() * (max - min) + min))
  );

async function extractText(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return "";
    return await el.innerText();
  } catch {
    return "";
  }
}

async function extractHtml(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return "";
    return await el.innerHTML();
  } catch {
    return "";
  }
}

async function extractHref(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return "";
    return await el.getAttribute("href") || "";
  } catch {
    return "";
  }
}

async function scrapeJobsInJapan() {
  const browser = await playwright.chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent: new UserAgent().toString(),
    locale: "en-US",
    timezoneId: "Asia/Tokyo",
  });

  const page = await context.newPage();

  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("div.job-content-wrap");

    const listings = await page.$$("div.job-content-wrap");
    const listingData = [];

    for (const card of listings) {
      const titleEl = await card.$(".loop-item-title a");
      const companyEl = await card.$(".company-name");
      const locationEl = await card.$(".job-location");

      const jobTitle = titleEl ? await titleEl.innerText() : "";
      const jobLink = titleEl ? await titleEl.getAttribute("href") : "";
      const companyName = companyEl ? await companyEl.innerText() : "";
      const location = locationEl ? await locationEl.innerText() : "";

      listingData.push({
        jobTitle: jobTitle.trim(),
        jobLink: (jobLink || "").trim(),
        companyName: companyName.trim(),
        location: location.trim(),
      });
    }

    const results = [];

    for (const job of listingData) {
      if (!job.jobLink) continue;

      const jobPage = await context.newPage();

      try {
        await jobPage.goto(job.jobLink, { waitUntil: "domcontentloaded" });
        await randomDelay();

        // Extract description from detail page
        const description = await extractHtml(
          jobPage,
          ".job-detail-description, .entry-content, .job-content"
        );

        // Extract company profile link
        const companyLink = await extractHref(
          jobPage,
          'a[href*="/companies/"]'
        );

        const urlPath = job.jobLink.split("/").filter(Boolean).pop() || job.jobLink;

        results.push({
          title: job.jobTitle,
          source_url: job.jobLink,
          description,
          posted_at: null,
          external_job_id: urlPath,
          external_source: "JobsInJapan",
          source_type: "SCRAPER",
          source_base_url: "https://jobsinjapan.com",
          is_remote: false,
          location: job.location,
          country_code: "JP",
          categories: [],
          company: {
            name: job.companyName || null,
            website: companyLink || null,
            country_code: "JP",
          },
        });
      } catch (err) {
        console.log("Failed job:", job.jobLink);
      }

      await jobPage.close();
      await randomDelay();
    }

    await browser.close();

    console.log(`Scraped ${results.length} jobs from JobsInJapan`);
    return results;
  } catch (err) {
    await browser.close();
    console.error("Error scraping JobsInJapan:", err.message);
    return [];
  }
}

module.exports = scrapeJobsInJapan;
