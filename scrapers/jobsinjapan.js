const fs = require("fs");
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

async function scrape() {
  const browser = await playwright.chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent: new UserAgent().toString(),
    locale: "en-US",
    timezoneId: "Asia/Tokyo",
  });

  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: "domcontentloaded" });

  await page.waitForSelector("div.job-content-wrap");

  const listings = await page.$$eval("div.job-content-wrap", (cards) =>
    cards.map((card) => {
      const titleEl = card.querySelector(".loop-item-title a");
      const companyEl = card.querySelector(".company-name");
      const locationEl = card.querySelector(".job-location");

      return {
        jobTitle: titleEl ? titleEl.innerText.trim() : "",
        jobLink: titleEl ? titleEl.href : "",
        companyName: companyEl ? companyEl.innerText.trim() : "",
        location: locationEl ? locationEl.innerText.trim() : "",
      };
    })
  );

  const results = [];

  for (const job of listings) {
    if (!job.jobLink) continue;

    const jobPage = await context.newPage();

    try {
      await jobPage.goto(job.jobLink, { waitUntil: "domcontentloaded" });

      await randomDelay();

      const companyProfileLink = await jobPage.$eval(
        'a[href*="/companies/"]',
        (el) => el.href
      ).catch(() => "");

      results.push({
        jobTitle: job.jobTitle,
        companyName: job.companyName,
        location: job.location,
        companyLink: companyProfileLink,
      });
    } catch (err) {
      console.log("Failed job:", job.jobLink);
    }

    await jobPage.close();
    await randomDelay();
  }

  await browser.close();

  fs.writeFileSync("jobs.json", JSON.stringify(results, null, 2));

  console.log(`Saved ${results.length} jobs to jobs.json`);
}

scrape().catch(console.error);