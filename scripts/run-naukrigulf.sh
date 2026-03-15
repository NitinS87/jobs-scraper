#!/bin/bash
# NaukriGulf daily scraper cron job
# Logs to /tmp/naukrigulf-cron.log

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd /Users/nitinsharma/Personal/jobs-scraper

LOG="/tmp/naukrigulf-cron.log"

echo "=== NaukriGulf scraper run: $(date) ===" >> "$LOG"

node -e "
require('dotenv').config();
const scrape = require('./scrapers/NaukriGulf-Scraper');
const { processScraperResults } = require('./lib/uploader');

(async () => {
  try {
    const jobs = await scrape();
    console.log('Scraped ' + jobs.length + ' jobs');
    const stats = await processScraperResults(jobs);
    console.log('Upload stats:', JSON.stringify(stats));
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
})();
" >> "$LOG" 2>&1

echo "=== Finished: $(date) ===" >> "$LOG"
