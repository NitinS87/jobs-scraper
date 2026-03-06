const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");

const FEED_URL = "https://jobicy.com/feed/job_feed";

async function scrapeJobicy() {
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
      categories: item.category
        ? Array.isArray(item.category)
          ? item.category
          : [item.category]
        : [],
      source: "Jobicy",
    }));

    // 4. Save to file
    fs.writeFileSync(
      "jobicy_jobs.json",
      JSON.stringify(jobs, null, 2)
    );

    console.log(`✅ Scraped ${jobs.length} jobs from Jobicy`);
  } catch (error) {
    console.error("❌ Error scraping Jobicy:", error.message);
  }
}

scrapeJobicy();
