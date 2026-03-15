const axios = require("axios");
const xml2js = require("xml2js");

const FEED_URL = "https://jobicy.com/feed/job_feed";

function mapJobType(type) {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower.includes("full")) return "FULL_TIME";
  if (lower.includes("part")) return "PART_TIME";
  if (lower.includes("contract") || lower.includes("freelance")) return "CONTRACT";
  if (lower.includes("intern")) return "INTERNSHIP";
  return null;
}

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

    // Extract numeric ID from URL
    const idMatch = (item.link || "").match(/\/job\/(\d+)/);
    const externalId = idMatch ? idMatch[1] : (item.link || "").split("/").filter(Boolean).pop();

    // Use content:encoded for full description, fallback to description
    const fullDescription = item["content:encoded"] || item.description || "";

    // Use structured fields from Jobicy RSS
    const companyName = item["job_listing:company"] || null;
    const location = item["job_listing:location"] || "Remote";
    const jobType = mapJobType(item["job_listing:job_type"]);

    // Get company logo from media:content
    let logoUrl = null;
    if (item["media:content"] && item["media:content"].$) {
      logoUrl = item["media:content"].$.url || null;
    }

    return {
      title: item.title,
      source_url: item.link,
      description: fullDescription,
      posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      external_job_id: externalId,
      external_source: "Jobicy",
      source_type: "RSS",
      source_base_url: "https://jobicy.com",
      is_remote: true,
      location,
      job_type: jobType,
      categories,
      company: companyName ? {
        name: companyName,
        logo_url: logoUrl,
      } : null,
    };
  });

  console.log(`Scraped ${jobs.length} jobs from Jobicy`);
  return jobs;
}

module.exports = scrapeJobicy;
