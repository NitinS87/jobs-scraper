 const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");

async function scrapeExternalJobLinks() {
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

  const jobsData = [];
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
          // Skip Easy Apply jobs
          const easyApplyElements = await job.findElements(
            By.xpath(".//span[contains(text(),'Easy Apply')]")
          );
          if (easyApplyElements.length > 0) continue;

          // Open job detail page
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

          // ================= LEFT SIDE DATA =================

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

          // Job description (both sections)
          const descriptionElements = await driver.findElements(
            By.css("article.job-description")
          );

          let fullDescription = "";
          for (const desc of descriptionElements) {
            fullDescription += (await desc.getText()) + "\n\n";
          }

          // ================= RIGHT SIDE DATA =================

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

          // Save final job data
          if (
            externalLink &&
            !jobsData.some(job => job.externalLink === externalLink)
          ) {
            jobsData.push({
              title,
              company,
              requirements,
              description: fullDescription.trim(),
              externalLink
            });
            jobsCollected++;
            console.log(`Collected (${jobsCollected}/15): ${title}`);
          }

          // Close tab and return
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

      // Pagination
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

    // Save to file
    fs.writeFileSync(
      "external_job_links.json",
      JSON.stringify(jobsData, null, 2),
      "utf8"
    );

    return jobsData;

  } finally {
    await driver.quit();
  }
}

module.exports = scrapeExternalJobLinks;
