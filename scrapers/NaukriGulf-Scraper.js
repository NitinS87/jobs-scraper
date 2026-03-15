const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

function parseExperienceToLevel(expStr) {
  if (!expStr) return null;
  const match = expStr.match(/(\d+)/);
  if (!match) return null;
  const years = parseInt(match[1], 10);
  if (years <= 2) return "ENTRY";
  if (years <= 5) return "MID";
  if (years <= 10) return "SENIOR";
  return "EXECUTIVE";
}

function parseSalary(salaryStr) {
  if (!salaryStr) return { min: null, max: null, currency: null };
  // Pattern: "AED 8,000 - 12,000" or "8000 - 12000 AED"
  const match = salaryStr.match(/(AED|USD|EUR)?\s*([\d,]+)\s*[-–—to]+\s*([\d,]+)\s*(AED|USD|EUR)?/i);
  if (!match) return { min: null, max: null, currency: null };
  return {
    min: parseInt(match[2].replace(/,/g, ""), 10),
    max: parseInt(match[3].replace(/,/g, ""), 10),
    currency: (match[1] || match[4] || "AED").toUpperCase(),
  };
}

function mapJobType(typeStr) {
  if (!typeStr) return null;
  const lower = typeStr.toLowerCase();
  if (lower.includes("full")) return "FULL_TIME";
  if (lower.includes("part")) return "PART_TIME";
  if (lower.includes("contract")) return "CONTRACT";
  if (lower.includes("intern")) return "INTERNSHIP";
  if (lower.includes("freelance")) return "FREELANCE";
  return null;
}

async function scrapeNaukriGulf() {
  const options = new chrome.Options();
  options.addArguments("--window-size=1920,1080");
  options.addArguments("--disable-blink-features=AutomationControlled");
  options.excludeSwitches("enable-automation");
  options.addArguments(
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  );

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  const results = [];
  let jobsCollected = 0;

  try {
    await driver.get(
      "https://www.naukrigulf.com/software-engineer-jobs?easyApply=false"
    );
    await driver.sleep(5000);

    let hasNextPage = true;

    while (hasNextPage && jobsCollected < 15) {
      await driver.wait(
        until.elementsLocated(By.css(".ng-box.srp-tuple")),
        10000
      );

      const jobs = await driver.findElements(By.css(".ng-box.srp-tuple"));

      for (const job of jobs) {
        if (jobsCollected >= 15) break;

        try {
          const easyApplyElements = await job.findElements(
            By.xpath(".//span[contains(text(),'Easy Apply')]")
          );
          if (easyApplyElements.length > 0) continue;

          const mainLinkElement = await job.findElement(
            By.css("a.info-position")
          );
          const mainJobUrl = await mainLinkElement.getAttribute("href");

          await driver.executeScript(
            `window.open('${mainJobUrl}', '_blank');`
          );
          await driver.sleep(3000);

          const handles = await driver.getAllWindowHandles();
          await driver.switchTo().window(handles[handles.length - 1]);

          // Job title
          const titleElement = await driver.findElement(
            By.css("h1.info-position")
          );
          const titleText = await titleElement.getText();
          const title = titleText.split("\n")[0];

          // Company name
          let company = "Not Mentioned";
          try {
            const companyElement = await driver.findElement(
              By.css("p.info-org")
            );
            company = await companyElement.getText();
          } catch {}

          // Candidate requirements
          const requirements = {};
          const requirementBlocks = await driver.findElements(
            By.css(".candidate-profile .col")
          );

          for (const block of requirementBlocks) {
            const head = await block.findElement(By.css(".head")).getText();
            const value = await block.findElement(By.css(".value")).getText();
            requirements[head.toLowerCase().replace(/\s+/g, "_")] = value;
          }

          // Job description
          const descriptionElements = await driver.findElements(
            By.css("article.job-description")
          );

          let fullDescription = "";
          for (const desc of descriptionElements) {
            fullDescription += (await desc.getText()) + "\n\n";
          }

          // External company link
          await driver.wait(
            until.elementLocated(
              By.css(".jd-company-desc a.anchor.ng-link")
            ),
            10000
          );

          const externalLinkElement = await driver.findElement(
            By.css(".jd-company-desc a.anchor.ng-link")
          );
          const externalLink = await externalLinkElement.getAttribute("href");

          if (
            externalLink &&
            !results.some((r) => r.external_job_id === mainJobUrl)
          ) {
            // Parse structured requirements
            const salary = parseSalary(requirements.salary);
            const urlPath = mainJobUrl.split("/").filter(Boolean).pop() || mainJobUrl;

            // Extract company website domain from externalLink
            let companyWebsite = null;
            try {
              companyWebsite = new URL(externalLink).origin;
            } catch {}

            // Build required_qualifications from education
            const reqQuals = [];
            if (requirements.education) reqQuals.push(requirements.education);

            results.push({
              title,
              source_url: mainJobUrl,
              description: fullDescription.trim(),
              posted_at: null,
              external_job_id: urlPath,
              external_source: "NaukriGulf",
              source_type: "SCRAPER",
              source_base_url: "https://www.naukrigulf.com",
              is_remote: false,
              location: requirements.location || null,
              country_code: "AE",
              job_type: mapJobType(requirements.job_type || requirements.employment_type),
              experience_level: parseExperienceToLevel(requirements.experience),
              salary_min: salary.min,
              salary_max: salary.max,
              salary_currency: salary.currency,
              required_qualifications: reqQuals,
              categories: [],
              company: {
                name: company,
                website: companyWebsite,
                location: requirements.location || null,
                country_code: "AE",
              },
            });

            jobsCollected++;
            console.log(`Collected (${jobsCollected}/15): ${title}`);
          }

          await driver.close();
          await driver.switchTo().window(handles[0]);
          await driver.sleep(1000);
        } catch (err) {
          console.log("Skipped one job due to error");
          const handles = await driver.getAllWindowHandles();
          if (handles.length > 1) {
            await driver.switchTo().window(handles[0]);
          }
        }
      }

      if (jobsCollected < 15) {
        try {
          const nextBtn = await driver.findElement(
            By.css("a[aria-label='Next']")
          );
          await driver.executeScript(
            "arguments[0].scrollIntoView(true);",
            nextBtn
          );
          await driver.sleep(1000);
          await nextBtn.click();
          await driver.sleep(5000);
        } catch {
          hasNextPage = false;
        }
      }
    }

    console.log(`Scraped ${results.length} jobs from NaukriGulf`);
    return results;
  } finally {
    await driver.quit();
  }
}

module.exports = scrapeNaukriGulf;
