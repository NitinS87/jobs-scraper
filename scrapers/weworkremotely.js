const axios = require("axios");
const xml2js = require("xml2js");
const cheerio = require("cheerio");
const { chromium } = require("playwright");
const { parseCountryCode } = require("../lib/descriptionParser");

const FEED_URLS = [
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
];

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

      // Company description
      const companyDescEl = document.querySelector(".company-card p, .company-description, .company-bio");
      if (companyDescEl) {
        result.company_description = companyDescEl.innerText.trim();
      }

      // Region/location from listing meta
      const regionEl = document.querySelector(".region, .location");
      if (regionEl) {
        result.region = regionEl.innerText.trim();
        result.location = regionEl.innerText.trim();
      }

      // Also check listing header for region info
      if (!result.region) {
        const headerEl = document.querySelector(".listing-header-container");
        if (headerEl) {
          const regionInHeader = headerEl.querySelector(".region, .location, [class*='region'], [class*='location']");
          if (regionInHeader) {
            result.region = regionInHeader.innerText.trim();
            result.location = regionInHeader.innerText.trim();
          }
        }
      }

      // Skills extraction from tag/skill elements
      const skillEls = document.querySelectorAll("[class*='skill'], [class*='tag'], .listing-tag, .tag");
      const skillSet = new Set();
      skillEls.forEach((el) => {
        const t = el.innerText.trim();
        if (t && t.length < 50) skillSet.add(t);
      });

      // Also extract tech keywords from description text
      const techKeywords = [
        'JavaScript', 'TypeScript', 'Python', 'Java', 'Golang', 'Go', 'Ruby', 'Rust',
        'C\\+\\+', 'C#', '\\.NET', 'PHP', 'Swift', 'Kotlin', 'Scala', 'Elixir',
        'React', 'Angular', 'Vue', 'Svelte', 'Next\\.js', 'Nuxt', 'Node\\.js', 'Express',
        'Django', 'Flask', 'FastAPI', 'Rails', 'Spring', 'Laravel',
        'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Ansible',
        'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'DynamoDB',
        'GraphQL', 'REST API', 'gRPC', 'Kafka', 'RabbitMQ',
        'Machine Learning', 'Deep Learning', 'PyTorch', 'TensorFlow',
        'HTML', 'CSS', 'Sass', 'Tailwind', 'Webpack', 'Vite',
        'Git', 'CI/CD', 'Jenkins', 'GitHub Actions',
        'Linux', 'SQL', 'NoSQL', 'Figma', 'Agile', 'Scrum',
        'Solidity', 'Web3', 'Blockchain',
      ];
      const techRegex = new RegExp('\\b(' + techKeywords.join('|') + ')\\b', 'gi');
      const techMatches = text.match(techRegex) || [];
      techMatches.forEach((m) => skillSet.add(m));
      result.skills = [...skillSet];

      // Requirements extraction: find <ul> lists after headings with requirement-like text
      const requirements = [];
      const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, strong, b");
      const reqPattern = /requirement|qualification|looking for|must have|what you.ll need|who you are/i;
      headings.forEach((heading) => {
        if (!reqPattern.test(heading.innerText)) return;
        let next = heading.tagName.match(/^(STRONG|B)$/i) ? heading.parentElement?.nextElementSibling : heading.nextElementSibling;
        let attempts = 0;
        while (next && attempts < 5) {
          if (next.tagName === "UL" || next.tagName === "OL") {
            next.querySelectorAll("li").forEach((li) => {
              const t = li.innerText.trim();
              if (t) requirements.push(t);
            });
            break;
          }
          if (/^H[1-6]$/.test(next.tagName)) break;
          const nestedList = next.querySelector("ul, ol");
          if (nestedList) {
            nestedList.querySelectorAll("li").forEach((li) => {
              const t = li.innerText.trim();
              if (t) requirements.push(t);
            });
            break;
          }
          next = next.nextElementSibling;
          attempts++;
        }
      });
      result.requirements = requirements;

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

function resolveLocation(regionText) {
  if (!regionText) return "Remote";
  const r = regionText.toLowerCase().trim();
  if (/anywhere in the world/i.test(r) || /worldwide/i.test(r) || /global/i.test(r)) return "Remote (Worldwide)";
  if (/\bus only\b/i.test(r) || r === "us" || r === "usa") return "Remote (US)";
  if (/\beurope only\b/i.test(r) || /\beu only\b/i.test(r)) return "Remote (Europe)";
  if (/\buk only\b/i.test(r)) return "Remote (UK)";
  if (/\bcanada only\b/i.test(r)) return "Remote (Canada)";
  if (/\blatam\b/i.test(r) || /latin america/i.test(r)) return "Remote (LATAM)";
  if (/\bapac\b/i.test(r) || /asia.pacific/i.test(r)) return "Remote (APAC)";
  return regionText.trim();
}

async function scrapeWeWorkRemotely() {
  // Step 1: Fetch all RSS feeds (no browser needed)
  const parser = new xml2js.Parser({ explicitArray: false });
  const seenLinks = new Set();
  const allRssItems = [];

  for (const feedUrl of FEED_URLS) {
    try {
      const response = await axios.get(feedUrl, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const parsed = await parser.parseStringPromise(response.data);
      const items = parsed.rss.channel.item;
      const feedItems = Array.isArray(items) ? items : items ? [items] : [];

      let added = 0;
      for (const item of feedItems) {
        const urlPath = (item.link || "").split("/").filter(Boolean).pop() || item.link;
        if (!seenLinks.has(urlPath)) {
          seenLinks.add(urlPath);
          allRssItems.push(item);
          added++;
        }
      }
      console.log(`  Feed ${feedUrl.split("/").pop()}: ${feedItems.length} items (${added} new, ${feedItems.length - added} duplicates)`);
    } catch (err) {
      console.warn(`  Failed to fetch feed ${feedUrl}: ${err.message}`);
    }
  }

  const rssItems = allRssItems;
  console.log(`Fetched ${rssItems.length} unique RSS items from WeWorkRemotely, fetching detail pages...`);

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
      // First link in RSS description is often the company website
      if (!companyWebsite) {
        const firstLink = $("a").first().attr("href") || "";
        if (firstLink.startsWith("http") && !firstLink.includes("weworkremotely.com")) {
          companyWebsite = firstLink;
        }
      }
      // Use RSS state field for company location
      const rssState = item.state || null;

      // Use detail page data when available, fall back to RSS
      const description = detail?.description || item.description;
      const regionText = detail?.region || detail?.location || item.region || null;
      const location = resolveLocation(regionText) || companyLocation || "Remote";
      const country_code = parseCountryCode(item.country || regionText || companyLocation) || null;

      // Job type from RSS field or detail page
      const rssType = item.type || null;
      let job_type = null;
      if (rssType) {
        const t = rssType.toLowerCase();
        if (t.includes("full")) job_type = "FULL_TIME";
        else if (t.includes("part")) job_type = "PART_TIME";
        else if (t.includes("contract")) job_type = "CONTRACT";
        else if (t.includes("freelance")) job_type = "FREELANCE";
      }

      // Skills from RSS field, supplemented by detail page
      const rssSkills = item.skills ? item.skills.split(/,\s*and\s*|,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean) : [];
      const combinedSkills = [...new Set([...rssSkills, ...(detail?.skills || [])])];

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
        country_code,
        salary_min,
        salary_max,
        salary_currency,
        job_type,
        skills: combinedSkills.length > 0 ? combinedSkills : [],
        requirements: detail?.requirements || [],
        company: {
          name: companyName,
          logo_url: detail?.company_logo || rssLogoImg,
          website: detail?.company_website || companyWebsite,
          location: companyLocation || rssState || null,
          description: detail?.company_description || null,
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
        country_code: null,
        company: { name: companyName },
        categories: [],
      };
    });
  } finally {
    await browser.close();
  }
}

module.exports = scrapeWeWorkRemotely;
