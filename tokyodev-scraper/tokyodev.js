const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    console.log("Opening TokyoDev...");

    await page.goto("https://www.tokyodev.com/jobs", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForSelector("div.flex-1", { timeout: 60000 });

    const jobs = await page.evaluate(() => {
      const results = [];

      // Each company block
      const companyBlocks = document.querySelectorAll("div.flex-1");

      companyBlocks.forEach((companyBlock) => {
        const companyLink = companyBlock.querySelector(
          "h3 a[href^='/companies/']"
        );
        if (!companyLink) return;

        const company = companyLink.innerText.trim();

        const jobItems = companyBlock.querySelectorAll(
          "div[data-collapsable-list-target='item']"
        );

        jobItems.forEach((jobItem) => {
          const titleLink = jobItem.querySelector(
            "a.font-bold[href*='/jobs/']"
          );
          if (!titleLink) return;

          const title = titleLink.innerText.trim();
          const job_url = titleLink.href;

          let location = null;

          const tags = jobItem.querySelectorAll("a.tag");
          tags.forEach((tag) => {
            const text = tag.innerText.trim().toLowerCase();
            if (text.includes("remote")) {
              location = tag.innerText.trim();
            }
          });

          results.push({
            title,
            company,
            location,
            job_url,
          });
        });
      });

      return results;
    });

    const outputPath = path.join(__dirname, "tokyodev.json");
    fs.writeFileSync(outputPath, JSON.stringify(jobs, null, 2));

    console.log(`✅ Scraped ${jobs.length} jobs`);
    console.log("Saved to tokyodev.json");
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await browser.close();
  }
})();