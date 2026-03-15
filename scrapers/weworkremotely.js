const axios = require("axios");
const xml2js = require("xml2js");
const cheerio = require("cheerio");
const { chromium } = require("playwright");

const FEED_URL =
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss";

const DETAIL_BATCH_SIZE = 5;
const DETAIL_PAGE_TIMEOUT = 15000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDetailPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: DETAIL_PAGE_TIMEOUT,
    });

    const detail = await page.evaluate(() => {
      const result = {};

      // Full listing body content
      const listingBody = document.querySelector(".listing-container") ||
        document.querySelector(".listing-body") ||
        document.querySelector("article");
      if (listingBody) {
        result.description = listingBody.innerHTML.trim();
      }

      const text = document.body.innerText;

      // Salary section
      const salaryMatch = text.match(/\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/);
      if (salaryMatch) {
        result.salary_min = parseInt(salaryMatch[1].replace(/,/g, ""), 10);
        result.salary_max = parseInt(salaryMatch[2].replace(/,/g, ""), 10);
        result.salary_currency = "USD";
      }

      // Application URL
      const applyLink = document.querySelector("a[href*='apply'], a.apply-button, a[class*='apply']");
      if (applyLink) {
        result.apply_url = applyLink.href;
      }

      // Company details
      const companyEl = document.querySelector(".company-card, .listing-header-container");
      if (companyEl) {
        const logo = companyEl.querySelector("img");
        if (logo) result.company_logo = logo.src;

        const website = companyEl.querySelector("a[href^='http']:not([href*='weworkremotely'])");
        if (website) result.company_website = website.href;
      }

      // Region/location from listing meta
      const regionEl = document.querySelector(".region, .location");
      if (regionEl) {
        result.location = regionEl.innerText.trim();
      }

      return result;
    });

    return detail;
  } catch (err) {
    console.warn(`Failed to fetch WWR detail page ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeWeWorkRemotely() {
  // Step 1: Fetch RSS feed (no browser needed)
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  const items = parsed.rss.channel.item;
  const rssItems = Array.isArray(items) ? items : [items];

  console.log(`Fetched ${rssItems.length} RSS items from WeWorkRemotely, fetching detail pages...`);

  // Step 2: Launch Playwright for detail pages
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  try {
    // Fetch detail pages in batches
    const detailResults = [];
    for (let i = 0; i < rssItems.length; i += DETAIL_BATCH_SIZE) {
      const batch = rssItems.slice(i, i + DETAIL_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((item) => fetchDetailPage(context, item.link))
      );
      detailResults.push(...batchResults);

      if (i + DETAIL_BATCH_SIZE < rssItems.length) {
        await delay(500 + Math.random() * 500);
      }
      console.log(`  Detail pages: ${Math.min(i + DETAIL_BATCH_SIZE, rssItems.length)}/${rssItems.length}`);
    }

    const jobs = rssItems.map((item, idx) => {
      const rawTitle = item.title || "";
      const companyFromCreator = item["dc:creator"] || null;
      const detail = detailResults[idx];

      // WWR titles are formatted as "Company: Job Title"
      let companyName = companyFromCreator;
      let cleanTitle = rawTitle;
      if (!companyName && rawTitle.includes(": ")) {
        const colonIdx = rawTitle.indexOf(": ");
        companyName = rawTitle.substring(0, colonIdx).trim();
        cleanTitle = rawTitle.substring(colonIdx + 2).trim();
      }

      // Parse RSS HTML description for fallback data
      const $ = cheerio.load(item.description || "");
      const rssLogoImg = $("img").first().attr("src") || null;

      let companyLocation = null;
      $("li").each((_, li) => {
        const text = $(li).text();
        if (/headquarters/i.test(text)) {
          companyLocation = text.replace(/headquarters:?\s*/i, "").trim();
        }
      });

      let companyWebsite = null;
      $("a").each((_, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text() || "";
        if (/apply|company|website/i.test(text) && href.startsWith("http")) {
          companyWebsite = href;
        }
      });

      // Use detail page data when available, fall back to RSS
      const description = detail?.description || item.description;
      const location = detail?.location || companyLocation || "Remote";

      // Salary: prefer detail page, fall back to RSS parsing
      let salary_min = detail?.salary_min || null;
      let salary_max = detail?.salary_max || null;
      let salary_currency = detail?.salary_currency || null;
      if (!salary_min) {
        const plainText = $.text();
        const salaryMatch = plainText.match(/\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/);
        if (salaryMatch) {
          salary_min = parseInt(salaryMatch[1].replace(/,/g, ""), 10);
          salary_max = parseInt(salaryMatch[2].replace(/,/g, ""), 10);
          salary_currency = "USD";
        }
      }

      const urlPath = (item.link || "").split("/").filter(Boolean).pop() || item.link;

      return {
        title: cleanTitle,
        source_url: item.link,
        description,
        posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
        external_job_id: urlPath,
        external_source: "WeWorkRemotely",
        source_type: "RSS",
        source_base_url: "https://weworkremotely.com",
        is_remote: true,
        location,
        salary_min,
        salary_max,
        salary_currency,
        company: {
          name: companyName,
          logo_url: detail?.company_logo || rssLogoImg,
          website: detail?.company_website || companyWebsite,
          location: companyLocation,
        },
        categories: [],
      };
    });

    console.log(`Scraped ${jobs.length} jobs from WeWorkRemotely (with detail pages)`);
    return jobs;
  } catch (err) {
    console.error("Error scraping WeWorkRemotely detail pages:", err.message);
    // Fall back to RSS-only data
    return rssItems.map((item) => {
      const rawTitle = item.title || "";
      const companyFromCreator = item["dc:creator"] || null;
      let companyName = companyFromCreator;
      let cleanTitle = rawTitle;
      if (!companyName && rawTitle.includes(": ")) {
        const colonIdx = rawTitle.indexOf(": ");
        companyName = rawTitle.substring(0, colonIdx).trim();
        cleanTitle = rawTitle.substring(colonIdx + 2).trim();
      }
      const urlPath = (item.link || "").split("/").filter(Boolean).pop() || item.link;
      return {
        title: cleanTitle,
        source_url: item.link,
        description: item.description,
        posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
        external_job_id: urlPath,
        external_source: "WeWorkRemotely",
        source_type: "RSS",
        source_base_url: "https://weworkremotely.com",
        is_remote: true,
        location: "Remote",
        company: { name: companyName },
        categories: [],
      };
    });
  } finally {
    await browser.close();
  }
}

module.exports = scrapeWeWorkRemotely;
