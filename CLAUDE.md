# Jobs Scraper

Collection of Node.js scrapers that pull job listings from various remote job boards and upload them to Supabase.

## Commands

```bash
pnpm install             # Install dependencies (requires Node.js)
pnpm test                # Unit + integration tests (node:test, no network, no DB)
node runScrapers.js      # Run all scrapers + upload to Supabase
```

## Architecture

- `runScrapers.js` — Sequential runner: scrape → parse → upload to Supabase
- `scrapers/` — Individual scraper modules, one per job board (each exports an async function returning standardized job arrays)
- `lib/` — Shared modules:
  - `supabaseClient.js` — Supabase client init (service role key)
  - `uploader.js` — Core DB integration (source, company, job upsert, category mapping). Batched — see below
  - `uploadPlanner.js` — Pure planning helpers for the uploader (content hashing, insert/update/skip classification, category diffing, key-signature grouping). No Supabase calls, so it is unit-testable
  - `taxonomy.generated.json` — Committed snapshot of the 392-node `job_categories` tree
    (19 roots / 85 groups / 288 leaves). Regenerate with `node scripts/syncTaxonomy.js`
  - `categoryScorer.js` — Pure title→category scoring against the taxonomy. No Supabase, so it
    is unit-testable (same rationale as `uploadPlanner.js`)
  - `categoryRules.js` — Pure data for the scorer: normalisation, curated rules, reject list
  - `categoryMatcher.js` — Thin async shim over the scorer; loads the live taxonomy, falls back
    to the committed snapshot
  - `categoryMappingWriter.js` — The single `job_category_mappings` write path, shared by the
    uploader and `scripts/recategorise.js`
  - `verticals.js` — Which taxonomy roots this run collects (rotation)
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

## Categorisation

Scope and classification are both defined by the Supabase taxonomy, not by hand-written lists.

- **`lib/jobFilter.js`'s `isProfessionalRole` is taxonomy membership**: a title is in scope iff
  `categoryScorer` can place it in the 392-node tree. The old EXCLUDE/INCLUDE keyword lists are
  gone — they contradicted the taxonomy and are why Education and Training held **0** jobs and
  Healthcare **3** as of 2026-09-18. A small residual deny-list survives for roles with no home
  anywhere in the tree (nurse, driver, cleaner, retail) because FINN and Cimix genuinely serve
  those categories.
- **Mappings are leaves-only.** 0 of 18,318 existing rows point at an interior node; roots
  populate by rollup through `parent_id`. Writing ancestor rows would break that invariant.
- **Scoring**: exact leaf name +10, curated rule 3–8, idf-weighted token overlap 0–4 (gated on
  the leaf's own rarest token being present), bigram +2, group/root +1.5/+1.0 as a
  *disambiguator* only — it applies once a leaf already scores ≥3, never as a detector.
  `THRESHOLD = 4`, at most 3 categories per job, **no fallback category ever**.
- ⚠️ **Tie-breaks must stay deterministic.** Five leaf names collide once the parenthetical
  disambiguator is stripped (`Project/Program Manager` ×3, `Network Engineer`, `Paralegal`,
  `Risk Analyst`, `Sales Engineer`). Without the ascending-id sort these flip run-to-run and
  `planCategorySync` emits an insert+delete pair per job forever.
- ⚠️ **`CATEGORY_ADDITIVE_ONLY=true` for the first week after any matcher change.** The uploader
  reconciles categories for *unchanged* jobs, so the first run emits deletes for every mapping
  the old rules produced and the new ones do not — across 15,027 already-categorised jobs.
  `sql/002_category_mappings_backup.sql` is the accompanying snapshot.
- Backfill: `node scripts/recategorise.js` (dry run by default, `--execute` to write).
  Measured 2026-09-18: 17,228 of 32,255 jobs had zero mappings and 251 of 392 categories were
  unused; the rewrite classifies 65.7% of that backlog and populates all 19 roots.

## Vertical rotation

`lib/verticals.js` picks which taxonomy roots each run collects, because all 19 roots from every
board does not fit the budget.

- `Software/Internet/AI` is **pinned to every run** (it is 10,090 of the mapped corpus); 6 of the
  other 18 rotate per run. `18 % 6 === 0`, so the windows partition cleanly and a full cycle is
  exactly 3 runs = **18h**. K=4 or 5 is coprime with 18 and stretches the cycle to 54h/108h.
- The slot is `floor(now / 6h)`, derived from the clock rather than a counter, so it aligns to
  the cron and a retry inside the same window picks the **identical** set.
- Scrapers keep the zero-argument convention: they `require('../lib/verticals')` and call
  `activeSlices()` inside the entry function. ⚠️ Passing the set via `process.env` from
  `runScrapers.js` does **not** work — the runner requires all 22 scraper modules while building
  its registry array, before `run()` executes, so module-level env reads see `undefined`.
- Per-vertical caps **subdivide** `<SOURCE>_MAX_JOBS`; they never raise a board's total.
- Wired into Teal, Cimix and FINN, where each slice is a full paging/detail pass. The remaining
  broadened boards are bounded by their caps instead.

## Supabase Integration

- **Project**: ApplymintAI (`pidjubyaqzoitmbixzbf`)
- **Tables**: `jobs`, `companies`, `job_sources`, `job_categories`, `job_category_mappings`
- **Storage**: `applymint` bucket, `company-logos/` folder
- **Dedup**: by `external_source` + `external_job_id`
- `.env` requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

### Batched ingestion (egress budget)

`pg_stat_statements` over 2026-02-07 → 2026-09-08 showed ~2.7M REST requests, all returning
exactly 1 row. Measured on the wire, ~2.2 GB of the ~3 GB egress was **HTTP response headers**
(~1.0 KB/request, half of it Cloudflare's `__cf_bm` cookie) — not row payloads. The uploader is
therefore optimised for **request count**, not response size:

- **One batched upsert per source**, not one write per job. `writeJobBatch()` chunks at 500.
- **Inserts and updates are separate batches on purpose.** An upsert carrying `is_active` would
  resurrect every row the 90-day expiry job has deactivated (8,404 of 18,293 as of 2026-09-08).
  `is_active` and `popular` are owned elsewhere and are stripped from updates.
- **PostgREST bulk payloads must have uniform keys** (PGRST102). Updates drop `posted_at` only
  when null, so batches are grouped by key signature before being sent.
- **Never chain `.select()` on a write.** supabase-js only sends `Prefer: return=representation`
  when you do (`postgrest-js/dist/index.cjs:566`); PostgREST otherwise defaults to
  `return=minimal` and replies 204 with an empty body. A full `jobs` row is ~8,979 B, 66% of it
  `description`.
- **`content_hash` skips no-op rewrites.** The table had 713K write tuples against 18K live rows
  (~39 rewrites) because the recency window re-scrapes the same week every 6h and rewrote
  byte-identical rows. A null stored hash always means "update" — never skip.
- **`job_category_mappings` has a composite PK `(job_id, category_id)`**, so mappings upsert with
  `ignoreDuplicates` and only genuinely-dropped ids are deleted. The old blanket
  DELETE-then-INSERT per job was ~880K calls.
- **Companies are prefetched once per process** (`id, name` only, paged) into a `lower(name)` map,
  reproducing the old `ilike()` semantics without a round-trip per company. Wide enrichment
  columns are fetched only for the companies a run actually touches.

**`sql/001_ingestion_perf.sql` was applied 2026-09-08** (Supabase migration
`ingestion_perf_upsert_target_and_content_hash`): unique constraint on
`(external_source, external_job_id)`, `jobs.content_hash`, and `companies (lower(name))`. The
uploader still probes for all of it once per process and falls back to the old per-row path if
absent, so the code stays deployable against a database without it.

⚠️ **`posted_at` and `source_posted_at` are deliberately excluded from the content hash.**
`sourcingxpress` and `englishjobs` resolve a relative date ("2 days ago") against the clock at
scrape time, so the value drifts on *every* run — measured 9/9 rows drifting per run, which
defeated no-op skipping entirely (`unchanged` stayed at 0). They are still written; they just do
not on their own justify rewriting an 8.9 KB row, and for a relative date the first-observed value
is closest to the true publication time. **Anything added to the hash must be deterministic across
two consecutive scrapes** — verify with a double-scrape diff before adding a field.

## Dependencies

- `@supabase/supabase-js` / `dotenv` — Supabase client + env config
- `axios` / `cheerio` — HTTP requests and HTML parsing
- `playwright` / `playwright-extra` + stealth plugin — Headless browser scraping
- `xml2js` — RSS/XML feed parsing

## Package Manager

Use `pnpm` (not npm) for all dependency operations.

## Deployment

⚠️ **The GitHub default branch is `feature/job-scraper`, not `main`.** `main` exists but is stale
and has no deploy role. `on: schedule` fires against the default branch, so **every push to
`feature/job-scraper` is a production deploy** — the 6-hourly cron picks it up on the next run.
Confirmed 2026-09-08 via `gh repo view --json defaultBranchRef` and `gh run list` (every scheduled
run reports `headBranch: feature/job-scraper`). Do not reason about this from the branch *name*;
check it. Merging to `main` deploys nothing.

## Gotchas

- **Configured slices rot silently.** Found 2026-09-18: 4 of RealWorkFromAnywhere's 5 RSS feeds
  returned HTTP 404 (it had been contributing design jobs only) and CutShort's `/jobs/product-jobs`
  and `/jobs/design-jobs` returned 55 KB empty shells. Both hid behind a per-slice try/catch whose
  warning scrolled past. `reportSliceHealth()` in `lib/scraperUtils.js` now logs at **error** level
  when half a board's slices come back empty — check that line before trusting a board's volume.

- `pnpm test` runs `node:test` (no framework dep). `lib/uploadPlanner.js` is unit-tested;
  `test/uploader.integration.test.js` drives `processScraperResults` against a mock Supabase
  client that counts requests, which is what pins the batching behaviour. Scrapers are untested
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
