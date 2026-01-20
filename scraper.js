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

  const jobLinks = [];
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

          await driver.wait(
            until.elementLocated(By.css(".jd-company-desc a.anchor.ng-link")),
            10000
          );

          const externalLinkElement = await driver.findElement(
            By.css(".jd-company-desc a.anchor.ng-link")
          );
          const externalUrl = await externalLinkElement.getAttribute("href");

          if (externalUrl && !jobLinks.includes(externalUrl)) {
            jobLinks.push(externalUrl);
            jobsCollected++;
            console.log(`Collected (${jobsCollected}/15):`, externalUrl);
          }

          await driver.close();
          await driver.switchTo().window(handles[0]);
        } catch (err) {
          const handles = await driver.getAllWindowHandles();
          if (handles.length > 1) await driver.switchTo().window(handles[0]);
        }
      }

      if (jobsCollected < 15) {
        try {
          const nextBtn = await driver.findElement(
            By.css("a[aria-label='Next']")
          );
          await driver.executeScript("arguments[0].scrollIntoView(true);", nextBtn);
          await driver.sleep(1000);
          await nextBtn.click();
          await driver.sleep(5000);
        } catch {
          hasNextPage = false;
        }
      }
    }

    fs.writeFileSync(
      "external_job_links.json",
      JSON.stringify(jobLinks, null, 2)
    );

    return jobLinks;
  } finally {
    await driver.quit();
  }
}

module.exports = scrapeExternalJobLinks;
