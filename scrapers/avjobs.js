const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");

const FEED_URL =
  "https://www.avjobs.com/special/RSS/rss_public_mgt_eng.asp";

async function scrapeAVJobs() {
  try {
    // 1. Fetch RSS feed
    const response = await axios.get(FEED_URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    // 2. Parse XML
    const parser = new xml2js.Parser({ explicitArray: false });
    const parsed = await parser.parseStringPromise(response.data);

    // 3. Extract items
    const items = parsed.rss.channel.item;

    const jobs = items.map((item) => ({
      title: item.title,
      link: item.link,
      description: item.description,
      publishedAt: item.pubDate,
      source: "AVJobs",
    }));

    // 4. Save to file
    fs.writeFileSync(
      "avjobs_jobs.json",
      JSON.stringify(jobs, null, 2)
    );

    console.log(`✅ Scraped ${jobs.length} jobs from AVJobs`);
  } catch (error) {
    console.error("❌ Error scraping AVJobs:", error.message);
  }
}

scrapeAVJobs();
