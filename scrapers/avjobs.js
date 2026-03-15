const axios = require("axios");
const xml2js = require("xml2js");

const FEED_URL =
  "https://www.avjobs.com/special/RSS/rss_public_mgt_eng.asp";

async function scrapeAVJobs() {
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  const items = parsed.rss.channel.item;

  const jobs = (Array.isArray(items) ? items : [items]).map((item) => {
    const urlPath = (item.link || "").split("/").filter(Boolean).pop() || item.link;
    const desc = item.description || "";

    // AVJobs descriptions start with "City, State Country - Job Description At Company, ..."
    // Parse location from beginning of description
    let location = null;
    let companyName = null;

    // Pattern: "Oklahoma City, OK United States - Job Description At Boeing, ..."
    const locMatch = desc.match(/^\s*(.+?)\s*-\s*Job Description/i);
    if (locMatch) {
      location = locMatch[1].trim();
    }

    // Parse company name: "At Boeing, we..." or "At Company Name, ..."
    const companyMatch = desc.match(/(?:Job Description\s+)?At\s+([A-Z][^,]+),/);
    if (companyMatch) {
      companyName = companyMatch[1].trim();
    }

    return {
      title: item.title,
      source_url: item.link,
      description: desc,
      posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      external_job_id: urlPath,
      external_source: "AVJobs",
      source_type: "RSS",
      source_base_url: "https://www.avjobs.com",
      is_remote: false,
      location: location,
      categories: [],
      company: companyName ? {
        name: companyName,
        industry: "Aviation",
      } : null,
    };
  });

  console.log(`Scraped ${jobs.length} jobs from AVJobs`);
  return jobs;
}

module.exports = scrapeAVJobs;
