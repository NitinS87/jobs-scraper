# Four new job sources: hyriko, getsethire, echojobs, huntyourtribe

## Context

Six candidate boards were proposed. All six were probed live on 2026-09-20 against
robots.txt, sitemaps, listing pages and detail pages. Four are worth building, one is
deferred because its backend is currently failing, and one is not a job board at all.

The repo already has 22 scrapers and a settled shape for adding one, so each of these is
bounded work against an existing pattern rather than new architecture.

### Probe results

| Site | Verdict | Mechanism | Detail data |
| --- | --- | --- | --- |
| hyriko.com | **Build** | axios + cheerio | Full JSON-LD `JobPosting`, ~1.5k desc |
| getsethire.in | **Build** | Single JSON API call | Title/company/location only — no desc |
| echojobs.io | **Build** | Stealth Playwright, paced | Full JSON-LD, **7.1k desc** |
| huntyourtribe.com | **Build** | Next.js RSC payload | No JSON-LD; fields escaped in RSC |
| nirdisha.in | **Defer** | — | All detail pages HTTP 500 |
| factanker.com | **Dropped** | — | Not a job board; licence blocker |

### Why factanker is dropped

Its `/llms.txt` documents a corporate-facts API — SEC filings, LEI, IRS 990s, FFIEC call
reports, USAspending awards. **The word "job" appears zero times in it.** `/jobs` is an
undocumented side page with no job links in static HTML. Two blockers settle it:

- Terms state *"individual use free with attribution; **bulk extraction needs an
  agreement**"* — a scraper is bulk extraction.
- `robots.txt` disallows `/api/` and `/mcp` for named AI bots while `llms.txt` invites
  them at 1200/min. Contradictory; the conservative reading governs.

Recorded in `CLAUDE.md` under "Evaluated and rejected" so nobody re-investigates. Its free
per-entity API remains interesting as a *company-enrichment* source (company → SEC CIK /
LEI / EIN) — a different feature, not in scope here.

### Why nirdisha is deferred

Its sitemap lists **1,833 `/job/*` detail URLs**, which would make it the easiest of the
six — no pagination needed. But every detail page tested returns HTTP 500 with the site's
own error text: *"This job did not load. Something on our side failed."* Listing pages
return 200 with zero job links (client-rendered). Re-probe in ~1 week; if the backend
recovers, it becomes a high-value, low-effort addition.

---

## Board 1 — hyriko (highest data quality, build first)

`scrapers/hyriko.js`, axios + cheerio. Mirrors the YCombinator/GulfTalent pattern: SSR
listing → detail page JSON-LD.

**Listing:** `https://hyriko.com{prefix}/jobs?page=N` — verified `?page=N` returns distinct
jobs. Five paths, all confirmed 200:

| Path | Jobs/page | Notes |
| --- | --- | --- |
| `/jobs` | 12 | India (default) |
| `/internships` | 30 | |
| `/remote-jobs` | 30 | |
| `/us/jobs` | 12 | |
| `/ca/jobs` | 12 | |

Job links are `/jobs/<slug>-<hash>`; extract with `href="/jobs/..."` and dedupe.

**Detail:** clean JSON-LD `JobPosting` — `title`, `datePosted`, `validThrough`,
`employmentType`, `hiringOrganization.name`, `jobLocation.address` with ISO
`addressCountry`, and ~1,482-char `description`. The external apply URL points at the real
company careers page (`careers.tataaig.com/...`) → use as `source_url`.

**Compliance:** `robots.txt` allows all except `/api/` and `/favorites`. We use HTML only,
so no conflict. ⚠️ Do not reach for their API even if one is discovered.

**Config:** `HYRIKO_MAX_JOBS` (default 300), `HYRIKO_DEADLINE_MS` (default 3 min),
`HYRIKO_MAX_PAGES` (default 10). Apply `isProfessionalRole` + `isLikelyEnglish`, and
`reportSliceHealth()` across the five paths.

## Board 2 — getsethire (cheapest, thinnest)

`scrapers/getsethire.js`, axios only. No pagination, no detail fetch, no browser.

```
GET https://api.getsethire.in/jobs?limit=2000   →  515 jobs, no auth
fields: id, role, compensation, company_name, location, job_type, job_id, createdAt, updatedAt
```

`?page` and `?offset` are ignored; only `limit` works, and 2000 returns the full 515, so
**one request is the whole corpus.**

⚠️ **No description, no apply URL, no detail endpoint.** These rows land with an empty
description, which matters twice: the category scorer is title-only anyway so
classification is unaffected, but job quality in the UI is visibly thinner. Map `role` →
title, `company_name`, `location`, `job_type` → employment type, `createdAt` →
`posted_at`. `compensation` is usually the literal string `"Not Mentioned"` — treat that
as null rather than storing it.

**Compliance:** `robots.txt` allows all. The site bundles FingerprintJS, so keep the
single request polite and identified by a normal UA.

**Config:** `GETSETHIRE_MAX_JOBS` (default 515). Runs in seconds — place early in the
registry.

## Board 3 — echojobs (richest descriptions, most expensive)

`scrapers/echojobs.js`, **stealth Playwright** via `launchStealthBrowser()`.

The site sits behind a Vercel Security Checkpoint: plain curl gets HTTP 429 and a
challenge page. A stealth browser renders it, and a **detail fetch paced at 8s returned
HTTP 200**. Detail JSON-LD is the best of all six:

```json
{"@type":"JobPosting","title":"Senior Project Manager","datePosted":"2026-09-20T16:20:23Z",
 "employmentType":"FULL_TIME",
 "hiringOrganization":{"name":"Dewberry","sameAs":"https://dewberry.com"},
 "jobLocation":{"address":{"addressLocality":"Boston, MA, US","addressCountry":"United States"}}}
```

7,121-character description, and `hiringOrganization.sameAs` gives the company website for
free — useful for the uploader's company enrichment.

⚠️ **Pacing is the whole design.** 8s per detail page means 60 jobs ≈ 8 minutes, which is a
material share of the 50-minute run budget. So: cap low, deadline hard, and place it last
among the non-Tier-C entries.

**Compliance:** `robots.txt` allows `/` but disallows `/api`, `/_next/data/`, `/auth`,
`/settings`. Use rendered HTML only — **never** `/_next/data/`, which is the tempting
shortcut for a Next.js site.

**Config:** `ECHOJOBS_MAX_JOBS` (default 60), `ECHOJOBS_DEADLINE_MS` (default 6 min),
`ECHOJOBS_DELAY_MS` (default 8000). Listing from `/jobs` and `/software-engineer-jobs`.
Return `[]` cleanly on a persistent 429 rather than throwing.

## Board 4 — huntyourtribe (lowest value, most brittle)

`scrapers/huntyourtribe.js`, axios + RSC payload parsing.

It is an **ATS product**, not a job board — `/jobs` lists its customers' postings, 145
links across `/jobs/companies/<co>` (company pages) and `/jobs/<co>/<uuid>` (real jobs).
No sitemap (404).

Detail pages carry **no** `JobPosting` JSON-LD — only `Organization`, `WebSite`,
`SoftwareApplication`. The job fields live in the Next.js app-router RSC stream as escaped
strings: `\"title\"`, `\"description\"`, `\"location\"`, `\"company\"`, `\"url\"`, `\"slug\"`
across 26 `self.__next_f.push` chunks. Extraction means concatenating those chunks,
unescaping, and locating the job object.

⚠️ **This is the brittle one.** RSC payload shape is a Next.js internal and changes without
notice. Budget for it breaking, keep the parser small and defensive, and let it return `[]`
rather than throw. Volume is capped by however many ATS customers they have — expect low
tens to low hundreds, not thousands.

**Config:** `HUNTYOURTRIBE_MAX_JOBS` (default 150), `HUNTYOURTRIBE_DEADLINE_MS` (2 min).

---

## Cross-cutting

**Registry order** in `runScrapers.js` — the budget truncates the tail, so cheapest first:

```
... existing cheap boards ...
GetSetHire     (1 request, seconds)
Hyriko         (axios, ~3 min)
HuntYourTribe  (axios, ~2 min)
... existing recency-windowed boards ...
EchoJobs       (Playwright, paced, ~6 min)  ← last before Tier C
```

**Rotation:** none of the four gets a `SLICE_MAP`. Their slices are country/category
variants rather than taxonomy roots, and all four are capped, so per-board caps bound the
cost. This matches the decision already taken for the other broadened boards.

**Filtering:** all four pass through `isProfessionalRole` + `isLikelyEnglish`. hyriko and
getsethire are India-heavy multi-vertical boards, so the taxonomy-membership filter is
doing real work there.

**Slice health:** hyriko and echojobs iterate multiple listing paths → wire
`reportSliceHealth()`. This is the guard that would have caught the RWFA and CutShort rot.

**Workflow:** add the five `*_MAX_JOBS` / `*_DEADLINE_MS` vars to `scrape-jobs.yml` using
the existing `${{ vars.X || 'default' }}` pattern.

## Verification

Per-board, before wiring into the registry:

1. `SCRAPER_ONLY=<name> node runScrapers.js` — confirm non-zero jobs and correct
   `inserted/updated/unchanged`, not just that it runs.
2. Spot-check 3 rows in Supabase per board: title, company, location, `country_code`,
   description length, `source_url` pointing at the real careers page.
3. Confirm the new rows categorise — query `job_category_mappings` for the new
   `external_source` and check the uncategorised rate is in line with comparable boards
   (Teal 4.6%, NaukriGulf 2.6%; anything above ~40% means the titles need scorer rules).
4. **Measure the full run afterwards.** These four add to an already-tight budget
   (15 original scrapers ≈ 34 min against a 50-min soft budget). Watch the closing
   `console.table` for `skipped:budget` rows; if the tail starves, cut `ECHOJOBS_MAX_JOBS`
   first since it is the most expensive per job.

Scrapers stay untested by unit tests, per the repo convention — but each one gets a live
smoke run before it lands. Two regressions on 2026-09-20 (Teal's `activeQueries is not
defined`, NaukriGulf's timeout) both came from *not* doing that, so it is non-negotiable
here.

## Risks

- **Budget.** Four new scrapers, one of them deliberately slow. Caps and ordering contain
  it; step 4 above is the gate.
- **huntyourtribe RSC parsing** will break on a Next.js upgrade. Accepted — it is the
  lowest-value board, and failure is contained to `[]`.
- **echojobs 429.** Even paced, sustained crawling may trip it. It must degrade to `[]`,
  never throw, and never fall back to `/_next/data/`.
- **getsethire thin rows.** If empty descriptions prove unacceptable in the UI, the board
  is trivially removable — one registry line.
