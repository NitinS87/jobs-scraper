const axios = require("axios");
const xml2js = require("xml2js");
const cheerio = require("cheerio");

const FEED_URL =
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss";

async function scrapeWeWorkRemotely() {
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  const items = parsed.rss.channel.item;

  const jobs = items.map((item) => {
    const rawTitle = item.title || "";
    const companyFromCreator = item["dc:creator"] || null;

    // Parse HTML description for rich data
    const $ = cheerio.load(item.description || "");

    // Company logo: first <img> tag (usually the WWR logo)
    const logoImg = $("img").first().attr("src") || null;

    // Company website: text after "Headquarters:" or "URL:"
    let companyWebsite = null;
    let companyLocation = null;

    $("li").each((_, li) => {
      const text = $(li).text();
      if (/headquarters/i.test(text)) {
        companyLocation = text.replace(/headquarters:?\s*/i, "").trim();
      }
    });

    // Look for URL in the description
    $("a").each((_, a) => {
      const href = $(a).attr("href") || "";
      const text = $(a).text() || "";
      if (/apply|company|website/i.test(text) && href.startsWith("http")) {
        companyWebsite = href;
      }
    });

    // Parse salary from text
    const plainText = $.text();
    let salary_min = null, salary_max = null, salary_currency = null;
    const salaryMatch = plainText.match(/\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/);
    if (salaryMatch) {
      salary_min = parseInt(salaryMatch[1].replace(/,/g, ""), 10);
      salary_max = parseInt(salaryMatch[2].replace(/,/g, ""), 10);
      salary_currency = "USD";
    }

    // Extract external_job_id from URL
    const urlPath = (item.link || "").split("/").filter(Boolean).pop() || item.link;

    return {
      title: rawTitle,
      source_url: item.link,
      description: item.description,
      posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      external_job_id: urlPath,
      external_source: "WeWorkRemotely",
      source_type: "RSS",
      source_base_url: "https://weworkremotely.com",
      is_remote: true,
      salary_min,
      salary_max,
      salary_currency,
      company: {
        name: companyFromCreator,
        logo_url: logoImg,
        website: companyWebsite,
        location: companyLocation,
      },
      categories: [],
    };
  });

  console.log(`Scraped ${jobs.length} jobs from WeWorkRemotely`);
  return jobs;
}

module.exports = scrapeWeWorkRemotely;
