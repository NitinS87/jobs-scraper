const playwright = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require("user-agents");

playwright.chromium.use(StealthPlugin());

const START_URL =
  "https://jobsinjapan.com/?s=software&location=&type=&_noo_job_field_english_level=&_noo_job_field_japanese_level=&_noo_job_field_employer_type=&post_type=noo_job";

const randomDelay = (min = 1000, max = 2500) =>
  new Promise((res) =>
    setTimeout(res, Math.floor(Math.random() * (max - min) + min))
  );

async function extractText(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return "";
    return await el.innerText();
  } catch {
    return "";
  }
}

async function extractHtml(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return "";
    return await el.innerHTML();
  } catch {
    return "";
  }
}

async function extractHref(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return "";
    return await el.getAttribute("href") || "";
  } catch {
    return "";
  }
}

async function scrapeJobsInJapan() {
  const browser = await playwright.chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent: new UserAgent().toString(),
    locale: "en-US",
    timezoneId: "Asia/Tokyo",
  });

  const page = await context.newPage();

  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("div.job-content-wrap");

    const listings = await page.$$("div.job-content-wrap");
    const listingData = [];

    for (const card of listings) {
      const titleEl = await card.$(".loop-item-title a");
      const companyEl = await card.$(".company-name");
      const locationEl = await card.$(".job-location");

      const jobTitle = titleEl ? await titleEl.innerText() : "";
      const jobLink = titleEl ? await titleEl.getAttribute("href") : "";
      const companyName = companyEl ? await companyEl.innerText() : "";
      const location = locationEl ? await locationEl.innerText() : "";

      listingData.push({
        jobTitle: jobTitle.trim(),
        jobLink: (jobLink || "").trim(),
        companyName: companyName.trim(),
        location: location.trim(),
      });
    }

    const results = [];

    for (const job of listingData) {
      if (!job.jobLink) continue;

      const jobPage = await context.newPage();

      try {
        await jobPage.goto(job.jobLink, { waitUntil: "domcontentloaded" });
        await randomDelay();

        // Extract description from detail page
        let description = await extractHtml(jobPage, ".job-desc");
        if (!description) {
          description = await extractHtml(jobPage, ".noo-main");
        }

        // Extract job overview details
        const jobOverview = await extractText(jobPage, ".job-details");

        // Combine overview + description
        if (jobOverview && description) {
          description = jobOverview + "\n\n" + description;
        } else if (jobOverview) {
          description = jobOverview;
        }

        // Extract posted date — try time[datetime] attribute first, then visible text patterns
        let postedAt = null;
        try {
          const timeEl = await jobPage.$('time[datetime]');
          if (timeEl) {
            const dt = await timeEl.getAttribute('datetime');
            if (dt) {
              const d = new Date(dt);
              if (!isNaN(d.getTime())) postedAt = d.toISOString();
            }
          }
        } catch {}
        // Try visible date in job overview text
        if (!postedAt && jobOverview) {
          // Match patterns like "March 15, 2026", "2026-03-15", "15 Mar 2026"
          const datePatterns = [
            /(?:Posted|Date|Published|Updated)[:\s]*(\w+\s+\d{1,2},?\s+\d{4})/i,
            /(?:Posted|Date|Published|Updated)[:\s]*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
            /(\d{1,2}\s+\w+\s+\d{4})/,
            /(\w+\s+\d{1,2},?\s+\d{4})/,
          ];
          for (const pattern of datePatterns) {
            const m = jobOverview.match(pattern);
            if (m) {
              const d = new Date(m[1].trim());
              if (!isNaN(d.getTime())) { postedAt = d.toISOString(); break; }
            }
          }
        }
        // Last resort: use page's meta date
        if (!postedAt) {
          try {
            const metaDate = await jobPage.$('meta[property="article:published_time"], meta[name="date"]');
            if (metaDate) {
              const content = await metaDate.getAttribute('content');
              if (content) {
                const d = new Date(content);
                if (!isNaN(d.getTime())) postedAt = d.toISOString();
              }
            }
          } catch {}
        }

        // Extract salary from job overview text
        let salary_min = null, salary_max = null, salary_currency = null;
        const salaryText = jobOverview || description || "";
        // ¥200,000 - ¥350,000 or 200,000 - 350,000
        const yenMatch = salaryText.match(/[¥￥]\s?([\d,]+)\s*[-–—~]+\s*[¥￥]?\s?([\d,]+)/);
        if (yenMatch) {
          salary_min = parseInt(yenMatch[1].replace(/,/g, ""), 10);
          salary_max = parseInt(yenMatch[2].replace(/,/g, ""), 10);
          salary_currency = "JPY";
        }
        // Also try "¥3,000,000 - ¥4,500,000 / Year"
        if (!salary_min) {
          const annualMatch = salaryText.match(/([\d,]+)\s*[-–—~]+\s*([\d,]+)\s*\/\s*(?:Year|Annual|Month)/i);
          if (annualMatch) {
            salary_min = parseInt(annualMatch[1].replace(/,/g, ""), 10);
            salary_max = parseInt(annualMatch[2].replace(/,/g, ""), 10);
            salary_currency = "JPY";
          }
        }

        // Extract job type from overview text
        let job_type = null;
        const overviewLower = (jobOverview || "").toLowerCase();
        if (/\bfull[- ]?time\b/.test(overviewLower)) job_type = "FULL_TIME";
        else if (/\bpart[- ]?time\b/.test(overviewLower)) job_type = "PART_TIME";
        else if (/\bcontract\b/.test(overviewLower)) job_type = "CONTRACT";
        else if (/\bfreelance\b/.test(overviewLower)) job_type = "FREELANCE";
        else if (/\bintern\b/.test(overviewLower)) job_type = "INTERNSHIP";

        // Detect remote from location or description
        const locationLower = (job.location || "").toLowerCase();
        const is_remote = locationLower.includes("remote") || overviewLower.includes("remote");

        // Extract company website — look for external links, not the generic /companies/ directory
        let companyWebsite = null;
        try {
          const links = await jobPage.$$('a[href^="http"]');
          for (const link of links) {
            const href = await link.getAttribute('href');
            if (href && !href.includes('jobsinjapan.com') && !href.includes('twitter.com') &&
                !href.includes('linkedin.com') && !href.includes('facebook.com') &&
                !href.includes('github.com')) {
              companyWebsite = href;
              break;
            }
          }
        } catch {}
        // Fallback: get specific company page link (not the generic directory)
        if (!companyWebsite) {
          try {
            const compLinks = await jobPage.$$('a[href*="/companies/"]');
            for (const link of compLinks) {
              const href = await link.getAttribute('href');
              // Only use if it's a specific company page, not the generic directory
              if (href && href !== 'https://jobsinjapan.com/companies/' &&
                  href !== '/companies/' && href.match(/\/companies\/.+/)) {
                companyWebsite = href;
                break;
              }
            }
          } catch {}
        }

        // Extract company logo
        const companyLogo = await (async () => {
          try {
            const el = await jobPage.$('.company-desc img, .noo-sidebar img');
            return el ? await el.getAttribute('src') : null;
          } catch { return null; }
        })();

        const urlPath = job.jobLink.split("/").filter(Boolean).pop() || job.jobLink;

        const result = {
          title: job.jobTitle,
          source_url: job.jobLink,
          description,
          posted_at: postedAt,
          external_job_id: urlPath,
          external_source: "JobsInJapan",
          source_type: "SCRAPER",
          source_base_url: "https://jobsinjapan.com",
          is_remote,
          location: job.location,
          country_code: "JP",
          categories: [],
          company: {
            name: job.companyName || null,
            website: companyWebsite || null,
            logo_url: companyLogo || null,
            country_code: "JP",
          },
        };

        if (job_type) result.job_type = job_type;
        if (salary_min) {
          result.salary_min = salary_min;
          result.salary_max = salary_max;
          result.salary_currency = salary_currency;
        }

        results.push(result);
      } catch (err) {
        console.log("Failed job:", job.jobLink);
      }

      await jobPage.close();
      await randomDelay();
    }

    await browser.close();

    console.log(`Scraped ${results.length} jobs from JobsInJapan`);
    return results;
  } catch (err) {
    await browser.close();
    console.error("Error scraping JobsInJapan:", err.message);
    return [];
  }
}

module.exports = scrapeJobsInJapan;
