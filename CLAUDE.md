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

Three approaches:
1. **RSS/XML feeds** (axios + xml2js) — Jobicy, WeWorkRemotely, AVJobs, RealWorkFromAnywhere
2. **Browser automation** (playwright) — TokyoDev, JobsInJapan, NaukriGulf, Wellfound (Tier C), SimplyHired (Tier C)
3. **JSON APIs / SSR scrape** (axios + cheerio) — HNHiring (HN Algolia API), YCombinator (JobPosting JSON-LD), CutShort (Next.js __NEXT_DATA__), NCS (POST `/api/v1/job-posts/search`)

WWR and RWFA scrape multiple RSS feed categories and deduplicate. Most scrapers fetch detail pages for richer data (JSON-LD, skills, salary, requirements). Company enrichment (website, location, description) is backfilled automatically by the uploader.

`lib/scraperUtils.js` provides shared helpers: `delay`, `randomDelay`, `isCloudflareChallenge`, `withTimeout`, `fetchInBatches`, `launchStealthBrowser`. New scrapers use these; existing ones still inline their own copies (refactor pending).

Each scraper exports an async function returning a standardized job array. No JSON files are written.

### Tier C scrapers (opt-in)

Wellfound and SimplyHired sit behind aggressive Cloudflare/Datadome protection and are gated by `ENABLE_TIER_C_SCRAPERS=true`. They return `[]` cleanly on a challenge or empty body. Don't rely on them for consistent volume.

### Phase 2 — API integrations (deferred, awaiting keys)

These two are planned but not implemented; both need free registration:
- **Adzuna** — `https://developer.adzuna.com/`. Set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. Endpoint: `https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`.
- **Jooble** — `https://jooble.org/api/about`. Set `JOOBLE_API_KEY`. POST to `https://jooble.org/api/{key}` with `{ keywords, location, page }`.

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
- NaukriGulf, TokyoDev, JobsInJapan, Wellfound, and SimplyHired use Playwright (run `pnpm exec playwright install chromium` if needed)
- Each scraper run is wrapped in a 5-minute timeout in `runScrapers.js` to prevent a hung Playwright page from stalling the whole pipeline
