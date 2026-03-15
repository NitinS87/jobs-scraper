const axios = require("axios");
const xml2js = require("xml2js");

const FEED_URL =
  "https://www.realworkfromanywhere.com/remote-developer-jobs/rss.xml";

async function scrapeRealWorkFromAnywhere() {
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({
    explicitArray: true,
    strict: false,
    trim: true,
  });

  const parsed = await parser.parseStringPromise(response.data);
  const channel = parsed?.RSS?.CHANNEL?.[0];
  const items = channel?.ITEM;

  if (!items || items.length === 0) {
    console.log("No jobs found in RealWorkFromAnywhere feed");
    return [];
  }

  const jobs = items.map((item) => {
    const title = item.TITLE?.[0] || "";
    const link = item.LINK?.[0] || "";
    const description = item.DESCRIPTION?.[0] || "";
    const pubDate = item.PUBDATE?.[0] || null;

    const urlPath = link.split("/").filter(Boolean).pop() || link;

    // Try to extract company name from title pattern "Title at Company"
    let companyName = null;
    const atMatch = title.match(/\bat\s+(.+)$/i);
    if (atMatch) {
      companyName = atMatch[1].trim();
    }

    return {
      title,
      source_url: link,
      description,
      posted_at: pubDate ? new Date(pubDate).toISOString() : null,
      external_job_id: urlPath,
      external_source: "RealWorkFromAnywhere",
      source_type: "RSS",
      source_base_url: "https://www.realworkfromanywhere.com",
      is_remote: true,
      categories: [],
      company: companyName ? { name: companyName } : null,
    };
  });

  console.log(`Scraped ${jobs.length} jobs from RealWorkFromAnywhere`);
  return jobs;
}

module.exports = scrapeRealWorkFromAnywhere;
