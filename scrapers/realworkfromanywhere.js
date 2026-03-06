const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");

const FEED_URL =
  "https://www.realworkfromanywhere.com/remote-developer-jobs/rss.xml";

async function scrapeRealWorkFromAnywhere() {
  try {
    // 1. Fetch RSS feed
    const response = await axios.get(FEED_URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    // 2. Parse XML (array + tolerant mode)
    const parser = new xml2js.Parser({
      explicitArray: true,
      strict: false,
      trim: true,
    });

    const parsed = await parser.parseStringPromise(response.data);

    // 3. Correct path (UPPERCASE)
    const channel = parsed?.RSS?.CHANNEL?.[0];
    const items = channel?.ITEM;

    if (!items || items.length === 0) {
      console.log("⚠️ No jobs found in RealWorkFromAnywhere feed");
      return;
    }

    // 4. Extract jobs
    const jobs = items.map((item) => ({
      title: item.TITLE?.[0] || null,
      link: item.LINK?.[0] || null,
      description: item.DESCRIPTION?.[0] || null,
      publishedAt: item.PUBDATE?.[0] || null,
      source: "RealWorkFromAnywhere",
    }));

    // 5. Save to JSON
    fs.writeFileSync(
      "realworkfromanywhere_jobs.json",
      JSON.stringify(jobs, null, 2)
    );

    console.log(
      `✅ Scraped ${jobs.length} jobs from RealWorkFromAnywhere`
    );
  } catch (error) {
    console.error(
      "❌ Error scraping RealWorkFromAnywhere:",
      error.message
    );
  }
}

// Run scraper
scrapeRealWorkFromAnywhere();
