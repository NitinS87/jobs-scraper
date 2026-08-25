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
  - `recency.js` — Recency-window policy for the high-volume boards (see below)

## Scraper Patterns

Three approaches:
1. **RSS/XML feeds** (axios + xml2js) — Jobicy, WeWorkRemotely, AVJobs, RealWorkFromAnywhere
2. **Browser automation** (playwright) — TokyoDev, JobsInJapan, NaukriGulf, WorkInDenmark, Wellfound (Tier C), SimplyHired (Tier C)
3. **JSON APIs / SSR scrape** (axios + cheerio) — HNHiring (HN Algolia API), YCombinator (JobPosting JSON-LD), CutShort (Next.js __NEXT_DATA__), NCS (POST `/api/v1/job-posts/search`), GulfTalent (mobile-site JSON-LD), SourcingXpress (SSR HTML), Cimix (JSON-LD per category), JobStairs (BeeSite API), JobbSafari (Next.js __NEXT_DATA__), FINN (SSR + JSON-LD), EnglishJobs (`?format=markdown`)

Teal is the exception to the "JSON API means axios" rule: its API is plain JSON but Cloudflare
rejects Node's TLS fingerprint, so it drives Playwright (see Gotchas).

WWR and RWFA scrape multiple RSS feed categories and deduplicate. Most scrapers fetch detail pages for richer data (JSON-LD, skills, salary, requirements). Company enrichment (website, location, description) is backfilled automatically by the uploader.

`lib/scraperUtils.js` provides shared helpers: `delay`, `randomDelay`, `isCloudflareChallenge`, `withTimeout`, `fetchInBatches`, `launchStealthBrowser`. New scrapers use these; existing ones still inline their own copies (refactor pending).

`lib/jobFilter.js` provides `isProfessionalRole(title)` and `isLikelyEnglish(title, description)`. The multi-vertical boards (GulfTalent, Cimix, WorkInDenmark) carry many non-tech / non-English listings, so those scrapers filter to tech + white-collar professional roles and English-only before/after detail fetch. Each of those four scrapers targets ~500 jobs/run, tunable via `GULFTALENT_MAX_JOBS` / `CIMIX_MAX_JOBS` / `WORKINDENMARK_MAX_JOBS` env vars.

Each scraper exports an async function returning a standardized job array. No JSON files are written.

### Recency window (high-volume boards)

Teal, JobStairs, EnglishJobs, FINN and JobbSafari carry 4k-50k listings each — far more than fits
in the 6-hourly CI budget. They use `lib/recency.js` instead of trying to fetch everything:

- Each normal run pulls only jobs published within `RECENCY_DAYS` (default 7). Because the cron
  runs every 6h and the uploader upserts idempotently, the active corpus accumulates over runs.
- `FULL_BACKFILL=true` disables the window. Use the **Backfill Jobs** workflow
  (`.github/workflows/backfill-jobs.yml`, manual dispatch) — never the cron path.
- `createPagingGuard()` stops paging after K consecutive pages that are entirely stale (default
  K=2, `RECENCY_STOP_PAGES`). Undated rows are **neutral** — they neither advance nor reset the
  streak — so a source that stops emitting dates degrades to "page until maxJobs" instead of
  terminating early. Pass `tolerancePages: Infinity` for boards that aren't date-ordered
  (EnglishJobs, JobbSafari, FINN); the guard still filters, it just never stops on date evidence.

`runScrapers.js` additions:

- Per-scraper `timeoutMs` in the registration object (defaults to `SCRAPER_TIMEOUT_MS`, 5 min).
- `RUN_BUDGET_MS` (default 35 min) — a soft whole-run budget. Scrapers past it are skipped with a
  `skipped:budget` row in the closing `console.table` rather than being SIGKILLed by GitHub.
- The upload phase is wrapped in `withTimeout` too (`UPLOAD_TIMEOUT_MS`, default 10 min).
- `SCRAPER_ONLY` / `SCRAPER_SKIP` — comma-separated name filters for targeted runs.

Array order in `runScrapers.js` is priority order, since the budget truncates the tail. The five
new sources sit after `WorkInDenmark` and before the Tier C entries, cheapest-first.

### Tier C scrapers (opt-in)

Wellfound and SimplyHired sit behind aggressive Cloudflare/Datadome protection and are gated by `ENABLE_TIER_C_SCRAPERS=true`. They return `[]` cleanly on a challenge or empty body. Don't rely on them for consistent volume.

### Phase 2 — API integrations (deferred, awaiting keys)

These two are planned but not implemented; both need free registration:
- **Adzuna** — `https://developer.adzuna.com/`. Set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. Endpoint: `https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`.
- **Jooble** — `https://jooble.org/api/about`. Set `JOOBLE_API_KEY`. POST to `https://jooble.org/api/{key}` with `{ keywords, location, page }`.

### Evaluated and rejected — do not re-investigate

- **instaffo.com** — no public job listings exist at all. It is a *reverse* marketplace: companies
  search a candidate pool. `/en/talent` is a signup funnel, `/jobs` and `/en/jobs` 404, the city
  pages (`/startup-jobs/berlin`) are SEO landers with zero `JobPosting` markup, the full 202-URL
  sitemap is marketing/legal, and `app.instaffo.com` is login-walled. Not a Playwright problem.
- **careerjet.se** — every job path (`/`, `/<keyword>-jobb`, `/jobad/<id>`) serves a Cloudflare
  Turnstile CAPTCHA. Warm cookie jars, full Sec-Fetch headers, HTTP/1.1 and a Googlebot UA were all
  blocked. The legacy `public.api.careerjet.net` endpoint is retired (401, "use v4 instead"). The
  only route is the Careerjet **v4 API** (`search.api.careerjet.net/v4/query`), which needs a free
  publisher key from careerjet.com/partners/api and caps at 1,000 results per query.

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
- NaukriGulf, TokyoDev, JobsInJapan, WorkInDenmark, Wellfound, and SimplyHired use Playwright (run `pnpm exec playwright install chromium` if needed)
- Each scraper run is wrapped in a 5-minute timeout in `runScrapers.js` to prevent a hung Playwright page from stalling the whole pipeline
- **GulfTalent**: bare axios gets 403; full browser-like headers (Sec-Ch-Ua, Sec-Fetch-*) pass. The desktop `/jobs/search` is an AngularJS SPA — scrape the server-rendered **mobile** site `/mobile/search/jobs-in-_/all/{page}` (25 jobs/page) and its `/mobile/<country>/jobs/<slug>-<id>` detail pages (JSON-LD JobPosting). Country comes from the URL segment.
- **Cimix**: Next.js RSC; `?page`/`?offset` are ignored, only `?categoryId=<id>` changes the result set (50 jobs/category). Iterate the tech/professional category IDs and dedupe. Detail pages have clean JSON-LD with English-translated titles and ISO `addressCountry`.
- **SourcingXpress**: recruiter-sourcing SaaS — only ~10 public jobs at `/search` (no working pagination), no JSON-LD. Title/company/location parsed from `og:title` ("X position at Y in Z"); INR "Lacs/Cr" salaries handled in-scraper.
- **WorkInDenmark**: Duende BFF. `/bff/FindJob/Search?resultsPerPage=100&pageNumber=N` returns full job records incl. full-HTML `description` — no detail pages needed. Requires the session cookie (set by loading `/find-job` in Playwright) **plus** the anti-forgery header `X-CSRF: 1`; without it the API returns 401. Call the API from page context via `page.evaluate(fetch(...))`.
- **Teal**: the JSON API (`resume-public.service.tealhq.com/public`) is open and unauthenticated,
  but Cloudflare fingerprints the **TLS ClientHello**, not just headers. `curl --http1.1` gets 200
  and `curl --http2` gets 403, yet *every* axios request gets 403 regardless of headers (UA, Origin,
  Referer, Sec-Fetch-*, Accept-Encoding all tried) because Node's TLS fingerprint is rejected. So
  this scraper drives Playwright: navigate **once** to the API origin, then issue **same-origin
  relative** fetches from page context. Fetching cross-origin from `www.tealhq.com` fails CORS.
  `per_page` caps at 100 (200 → 403) and `meta.total` caps at 10,000/query, so slice by keyword.
  `min_posted_at=<days>` is a native recency filter. `body` is PLAIN TEXT, not HTML.
- **JobStairs**: BeeSite "gjb" API at `api.jobstairs.de/v6/gjb_search?data=<urlencoded JSON>`.
  ⚠️ Use **GET**. The POST form honours `SearchCriteria` but **silently ignores
  `SearchParameters`** — always 10 items regardless of `FirstItem`/`CountItem`, and returns one of
  two stale cached bodies depending on which backend (`X-Host: jslive01/03`) answers.
  `PublicationLanguage.Code` 1 = German (28,144), 2 = English (673) — this is how English-only is
  enforced, since German tech ads are titled "Senior DevOps Engineer (w/m/d)" and defeat the title
  heuristic. `CriterionName: 'ID'` accepts an ID list, which enables the two-phase fetch (fast
  metadata listing, then descriptions only for survivors). Responses are cache-sensitive: a cold
  call took 38s, the same call warm 2s. Detail pages on www are useless (~44s, no JSON-LD).
- **FINN**: ⚠️ robots.txt **explicitly prohibits crawling** ("Crawling FINN.no is prohibited unless
  you have written permission", repeated in Norwegian, citing åndsverksloven). Job paths are not in
  the `Disallow` list, but the ban is stated; the repo owner reviewed this and chose to proceed.
  `/job/fulltime/search.html` 301s to `/job/search`. Pagination caps hard at **page 50** — page 51+
  returns HTTP 500 — so slice by `occupation=0.NN` (the facet codes are enumerated in the scraper).
  ⚠️ FINN wraps its JSON-LD in an envelope: `{"script:ld+json": {...}}`, so a naive
  `d['@type'] === 'JobPosting'` check finds nothing — unwrap first.
- **JobbSafari**: Next.js pages-router SSR; parse `#__NEXT_DATA__` →
  `props.pageProps.jobEntries.results[]` (30/page, ~50k total). `startDate` is the ad **publication**
  date, not tillträdesdatum — it sits in the past with `endDate` (application deadline) in the
  future, and matches the detail page's JSON-LD `datePosted`. ⚠️ Results are ordered by
  relevance/campaign, **not** by date (page 5 contains year-old ads while page 300 is entirely
  recent), and every sort parameter tried is ignored — so never stop paging on date evidence here.
  robots.txt allows `?page=N` but disallows `yrke=`/`ort=`/`kategori=`/`foretag=` and any URL with
  4+ query params, so never add facets. Detail JSON-LD has no `addressCountry` → hardcode `SE`.
- **EnglishJobs**: the site publishes a `/llms.txt` documenting its own machine interface — read it
  first. Any page accepts `?format=markdown`, but links inside a Markdown response point at
  canonical HTML URLs, so the parameter must be re-appended on every request. Pagination is
  `?page=N` at 20/page (`?pg=` and `/2` silently return page 1). ⚠️ Most listings have **no detail
  page**: cards link to `/clickout/<hash>`, which is `Disallow`-ed in robots.txt — never follow it.
  Everything comes off the card, so descriptions are a short snippet. The `<hash>` is stable across
  fetches and serves as the dedup key. The redirect path varies (`/clickout/`, `/clickout_alt/`,
  `/clickredirect/`, `/subredirect/`) — the card regex must cover all of them or titles run
  together. We iterate the 16 federal **states** rather than the ~90 cities.
- **Unhandled rejections are fatal on Node 22**, and `runScrapers.js` installs a
  `process.on('unhandledRejection')` guard because of it. playwright-extra's stealth plugin emits
  `cdpSession.send: Target page, context or browser has been closed` from an async internal handler
  when a navigation dies (reproduced via NaukriGulf), and **no try/catch inside the scraper can
  catch it** — it killed the entire run at scraper 7 of 22, silently skipping every source behind
  it. The guard logs loudly and lets the run continue. If you see that line in CI logs, the scraper
  named just above it is the one to investigate.
- **`parseCountryCode` matching**: the free-text fallback is longest-key-first with Unicode-aware
  word boundaries. It used to be an unanchored `includes()` in object order, which resolved
  "Ukraine" and "Fukuoka" to `GB` via the `uk` key. Bare 2-letter ISO codes are matched only in the
  comma-split branch (via `ISO_CODES`), never in free text, because NO/IN/IT/IS/AT/BE are English
  words — and that branch runs **before** the US-state check, since DE/IN/LA/MS/OK/OR/PA/WA are both
  ISO codes and US state abbreviations ("Berlin, DE" used to resolve to US).
