# Jobs Scraper

Collection of Node.js scrapers that pull job listings from various remote job boards and upload them to Supabase.

## Commands

```bash
pnpm install             # Install dependencies (requires Node.js)
node runScrapers.js      # Run all scrapers + upload to Supabase
```

## Architecture

- `runScrapers.js` — Sequential runner: scrape → parse → upload to Supabase
- `scrapers/` — Individual scraper modules, one per job board (each exports an async function returning standardized job arrays)
- `lib/` — Shared modules:
  - `supabaseClient.js` — Supabase client init (service role key)
  - `uploader.js` — Core DB integration (source, company, job upsert, category mapping)
  - `categoryMatcher.js` — Maps job titles to 392 existing DB categories via keyword matching
  - `logoUploader.js` — Logo download + Supabase storage upload + favicon fallback
  - `descriptionParser.js` — Shared HTML parser for requirements/skills/salary/benefits extraction + `parseCountryCode()` + `parseSalaryText()`

## Scraper Patterns

Two main approaches:
1. **RSS/XML feeds** (axios + xml2js) — Jobicy, WeWorkRemotely, AVJobs, RealWorkFromAnywhere
2. **Browser automation** (playwright) — TokyoDev, JobsInJapan, NaukriGulf

WWR and RWFA scrape multiple RSS feed categories and deduplicate. Most scrapers fetch detail pages for richer data (JSON-LD, skills, salary, requirements). Company enrichment (website, location, description) is backfilled automatically by the uploader.

Each scraper exports an async function returning a standardized job array. No JSON files are written.

## Supabase Integration

- **Project**: ApplymintAI (`pidjubyaqzoitmbixzbf`)
- **Tables**: `jobs`, `companies`, `job_sources`, `job_categories`, `job_category_mappings`
- **Storage**: `applymint` bucket, `company-logos/` folder
- **Dedup**: by `external_source` + `external_job_id`
- `.env` requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

## Dependencies

- `@supabase/supabase-js` / `dotenv` — Supabase client + env config
- `axios` / `cheerio` — HTTP requests and HTML parsing
- `playwright` / `playwright-extra` + stealth plugin — Headless browser scraping
- `xml2js` — RSS/XML feed parsing

## Package Manager

Use `pnpm` (not npm) for all dependency operations.

## Gotchas

- No test suite exists yet
- Some scrapers need a working Chrome/Chromium install for Playwright
- `.env` is gitignored — needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- NaukriGulf, TokyoDev, and JobsInJapan use Playwright (run `pnpm exec playwright install chromium` if needed)
