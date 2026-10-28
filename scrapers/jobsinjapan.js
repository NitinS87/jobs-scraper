const playwright = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require("user-agents");
const { isCloudflareChallenge } = require("../lib/scraperUtils");

playwright.chromium.use(StealthPlugin());

// The site moved from WordPress to Next.js around 2026-10-10. The old search
// (`/?s=<term>&post_type=noo_job`) now redirects to `/jobs/?s=<term>` and the
// `div.job-content-wrap` cards are gone, which is why the board silently
// returned 0 jobs. The whole board is small (108 jobs on 2026-10-28, 30 per
// page), so instead of keyword slices this pages the unfiltered "latest" list
// and reads each job's JobPosting JSON-LD.
//
// ⚠️ Plain HTTP clients (curl/axios) get `403 cf-mitigated: challenge`; the
// browser gets the page normally. That is why this stays on Playwright.
const BASE = "https://jobsinjapan.com";
const MAX_PAGES = Number(process.env.JOBSINJAPAN_MAX_PAGES) || 10;
const MAX_JOBS = Number(process.env.JOBSINJAPAN_MAX_JOBS) || 500;

const randomDelay = (min = 1000, max = 2500) =>
  new Promise((res) =>
    setTimeout(res, Math.floor(Math.random() * (max - min) + min))
  );

const listingUrl = (n) =>
  n <= 1 ? `${BASE}/jobs/?sort=latest` : `${BASE}/jobs/page/${n}/?sort=latest`;

/**
 * The last path segment, normalised to lowercase percent-escapes — the form
 * every pre-redesign row stored as external_job_id, so old rows still dedupe.
 */
function slugId(url) {
  const segment = String(url).split("?")[0].split("/").filter(Boolean).pop() || "";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {}
  return encodeURIComponent(decoded).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

function mapEmploymentType(t) {
  if (!t) return null;
  const upper = String(Array.isArray(t) ? t[0] : t).toUpperCase().replace(/[\s-]/g, "_");
  if (upper.includes("FULL")) return "FULL_TIME";
  if (upper.includes("PART")) return "PART_TIME";
  if (upper.includes("INTERN")) return "INTERNSHIP";
  if (upper.includes("CONTRACT") || upper.includes("TEMPORARY")) return "CONTRACT";
  if (upper.includes("FREELANCE")) return "FREELANCE";
  return null;
}

/** Map a detail page's JobPosting JSON-LD onto the standard job shape. */
function parseJobPosting(ld) {
  if (!ld || ld["@type"] !== "JobPosting") return null;
  const title = (ld.title || "").trim();
  if (!title || !ld.url) return null;

  const address = (ld.jobLocation && ld.jobLocation.address) || {};
  const location = [...new Set([address.addressLocality, address.addressRegion].filter(Boolean))].join(", ");
  const is_remote = /telecommute/i.test(String(ld.jobLocationType || ""))
    || /\bremote\b/i.test(`${title} ${location}`);

  const salaryValue = (ld.baseSalary && ld.baseSalary.value) || {};
  const salary_min = Number(salaryValue.minValue) || null;
  const salary_max = Number(salaryValue.maxValue) || null;

  const org = ld.hiringOrganization || {};
  const posted = ld.datePosted ? new Date(ld.datePosted) : null;

  return {
    title,
    source_url: ld.url,
    description: ld.description || "",
    posted_at: posted && !isNaN(posted.getTime()) ? posted.toISOString() : null,
    external_job_id: slugId(ld.url),
    external_source: "JobsInJapan",
    source_type: "SCRAPER",
    source_base_url: BASE,
    is_remote,
    location,
    country_code: "JP",
    job_type: mapEmploymentType(ld.employmentType),
    salary_min,
    salary_max,
    salary_currency: salary_min || salary_max ? ld.baseSalary.currency || "JPY" : null,
    categories: [],
    company: {
      name: org.name || null,
      // `url` is the board's own company page; `sameAs` is the employer's site.
      website: org.sameAs || null,
      // org.logo lives on media.jobsinjapan.com, which 403s the uploader's axios
      // fetch like the rest of the Cloudflare-fronted host (64 of 64 on the
      // 2026-10-28 run). Leaving it null sends the uploader straight to the
      // website favicon fallback instead of a doomed request per company.
      logo_url: null,
      country_code: "JP",
    },
  };
}

async function scrapeJobsInJapan() {
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: new UserAgent().toString(),
      locale: "en-US",
      timezoneId: "Asia/Tokyo",
    });
    const page = await context.newPage();

    const links = [];
    const seen = new Set();

    for (let n = 1; n <= MAX_PAGES && links.length < MAX_JOBS; n++) {
      const url = listingUrl(n);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("article.jij-job-card", { timeout: 15000 });
      } catch (err) {
        const html = await page.content().catch(() => "");
        const reason = isCloudflareChallenge(html) ? "Cloudflare challenge" : err.message;
        // Page 1 failing means the layout changed again or we are blocked —
        // say so loudly rather than returning a quiet 0.
        (n === 1 ? console.error : console.warn)(`JobsInJapan: listing ${url} failed: ${reason}`);
        break;
      }

      const hrefs = await page.$$eval("article.jij-job-card h2 a[href]", (as) =>
        as.map((a) => a.href)
      );
      let added = 0;
      for (const href of hrefs) {
        if (seen.has(href)) continue;
        seen.add(href);
        links.push(href);
        added += 1;
      }
      console.log(`JobsInJapan: page ${n} → ${hrefs.length} cards (${added} new)`);

      const hasNext = await page.$('a[aria-label="Next page"]');
      if (!added || !hasNext) break;
      await randomDelay();
    }

    const results = [];
    for (const link of links.slice(0, MAX_JOBS)) {
      try {
        await page.goto(link, { waitUntil: "domcontentloaded" });
        const blocks = await page.$$eval('script[type="application/ld+json"]', (ss) =>
          ss.map((s) => s.textContent)
        );
        let posting = null;
        for (const raw of blocks) {
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            continue;
          }
          const nodes = Array.isArray(data) ? data : data["@graph"] || [data];
          posting = nodes.find((x) => x && x["@type"] === "JobPosting") || posting;
        }
        const job = parseJobPosting(posting);
        if (job) results.push(job);
        else console.warn(`JobsInJapan: no JobPosting JSON-LD on ${link}`);
      } catch (err) {
        console.warn(`JobsInJapan: detail failed ${link}: ${err.message}`);
      }
      await randomDelay();
    }

    console.log(`Scraped ${results.length} jobs from JobsInJapan (${links.length} listed)`);
    return results;
  } catch (err) {
    console.error("Error scraping JobsInJapan:", err.message);
    return [];
  } finally {
    await browser.close();
  }
}

module.exports = scrapeJobsInJapan;
module.exports.parseJobPosting = parseJobPosting;
module.exports.slugId = slugId;
module.exports.listingUrl = listingUrl;
