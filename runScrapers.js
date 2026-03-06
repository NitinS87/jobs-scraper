const { exec } = require("child_process");

const scripts = [
  "node scrapers/avjobs.js",
  "node scrapers/jobicy.js",
  "node scrapers/jobsinjapan.js",
  "node scrapers/NaukriGulf-Scraper.js",
  "node scrapers/realworkfromanywhere.js",
  "node scrapers/scraper_old.js",
  "node scrapers/tokyodev.js",
  "node scrapers/weworkremotely.js"
];

async function runScripts() {
  for (const script of scripts) {
    console.log(`Running: ${script}`);

    await new Promise((resolve, reject) => {
      exec(script, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error in ${script}`);
          console.error(stderr);
          resolve(); // continue to next scraper
        } else {
          console.log(stdout);
          resolve();
        }
      });
    });
  }

  console.log("All scrapers finished.");
}

runScripts();