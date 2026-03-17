require('dotenv').config();
const { processScraperResults } = require('./lib/uploader');

const scrapers = [
  { name: 'WeWorkRemotely', fn: require('./scrapers/weworkremotely') },
  { name: 'Jobicy', fn: require('./scrapers/jobicy') },
  { name: 'AVJobs', fn: require('./scrapers/avjobs') },
  { name: 'RealWorkFromAnywhere', fn: require('./scrapers/realworkfromanywhere') },
  { name: 'TokyoDev', fn: require('./scrapers/tokyodev') },
  { name: 'JobsInJapan', fn: require('./scrapers/jobsinjapan') },
  { name: 'NaukriGulf', fn: require('./scrapers/NaukriGulf-Scraper') },
];

async function run() {
  for (const { name, fn } of scrapers) {
    try {
      console.log(`\nRunning ${name}...`);
      const jobs = await fn();
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
