const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");

const FEED_URL =
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss";

async function scrapeWeWorkRemotely() {
  try {
    // 1. Fetch RSS feed (simple GET)
    const response = await axios.get(FEED_URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0", // normal UA, nothing fancy
      },
    });

    // 2. Parse XML
    const parser = new xml2js.Parser({ explicitArray: false });
    const parsed = await parser.parseStringPromise(response.data);

    // 3. Navigate to items
    const items = parsed.rss.channel.item;

    // 4. Extract useful fields
    const jobs = items.map((item) => ({
      title: item.title,
      link: item.link,
      description: item.description,
      publishedAt: item.pubDate,
      company: item["dc:creator"] || null,
      source: "WeWorkRemotely",
    }));

    // 5. Save to file
    fs.writeFileSync(
      "weworkremotely_jobs.json",
      JSON.stringify(jobs, null, 2)
    );

    console.log(`✅ Scraped ${jobs.length} jobs from WeWorkRemotely`);
  } catch (error) {
    console.error("❌ Error scraping WeWorkRemotely:", error.message);
  }
}

scrapeWeWorkRemotely();
