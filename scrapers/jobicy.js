const axios = require("axios");
const xml2js = require("xml2js");

const FEED_URL = "https://jobicy.com/feed/job_feed";

async function scrapeJobicy() {
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  const items = parsed.rss.channel.item;

  const jobs = items.map((item) => {
    const categories = item.category
      ? Array.isArray(item.category)
        ? item.category
        : [item.category]
      : [];

    // Extract numeric ID from URL (e.g., /job/12345/...)
    const idMatch = (item.link || "").match(/\/job\/(\d+)/);
    const externalId = idMatch ? idMatch[1] : (item.link || "").split("/").filter(Boolean).pop();

    // Decode HTML entities in description
    const description = (item.description || "")
      .replace(/&#8217;/g, "'")
      .replace(/&#8216;/g, "'")
      .replace(/&#8220;/g, '"')
      .replace(/&#8221;/g, '"')
      .replace(/&#8211;/g, "–")
      .replace(/&#8212;/g, "—")
      .replace(/&amp;/g, "&");

    return {
      title: item.title,
      source_url: item.link,
      description,
      posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      external_job_id: externalId,
      external_source: "Jobicy",
      source_type: "RSS",
      source_base_url: "https://jobicy.com",
      is_remote: true,
      categories,
      company: null, // Jobicy RSS doesn't include company separately
    };
  });

  console.log(`Scraped ${jobs.length} jobs from Jobicy`);
  return jobs;
}

module.exports = scrapeJobicy;
