require('dotenv').config();
const { processScraperResults } = require('./lib/uploader');
const { withTimeout } = require('./lib/scraperUtils');

const SCRAPER_TIMEOUT_MS = 5 * 60 * 1000;

const scrapers = [
  { name: 'WeWorkRemotely', fn: require('./scrapers/weworkremotely') },
  { name: 'Jobicy', fn: require('./scrapers/jobicy') },
  { name: 'AVJobs', fn: require('./scrapers/avjobs') },
  { name: 'RealWorkFromAnywhere', fn: require('./scrapers/realworkfromanywhere') },
  { name: 'TokyoDev', fn: require('./scrapers/tokyodev') },
  { name: 'JobsInJapan', fn: require('./scrapers/jobsinjapan') },
  { name: 'NaukriGulf', fn: require('./scrapers/NaukriGulf-Scraper') },
  { name: 'HNHiring', fn: require('./scrapers/hnhiring') },
  { name: 'YCombinator', fn: require('./scrapers/ycombinator') },
  { name: 'CutShort', fn: require('./scrapers/cutshort') },
  { name: 'NCS', fn: require('./scrapers/ncs') },
  { name: 'Wellfound', fn: require('./scrapers/wellfound'), optional: true },
  { name: 'SimplyHiredIN', fn: require('./scrapers/simplyhired'), optional: true },
];

async function run() {
  for (const { name, fn, optional } of scrapers) {
    if (optional && process.env.ENABLE_TIER_C_SCRAPERS !== 'true') {
      console.log(`\nSkipping ${name} (Tier C — set ENABLE_TIER_C_SCRAPERS=true to enable)`);
      continue;
    }
    try {
      console.log(`\nRunning ${name}...`);
      const jobs = await withTimeout(fn(), SCRAPER_TIMEOUT_MS, `${name} scraper`);
      console.log(`${name}: scraped ${jobs.length} jobs`);

      const stats = await processScraperResults(jobs);
      console.log(`${name}: inserted=${stats.inserted}, updated=${stats.updated}, errors=${stats.errors}`);
    } catch (err) {
      console.error(`${name} failed:`, err.message);
    }
  }
  console.log('\nAll scrapers finished.');
}

run();
