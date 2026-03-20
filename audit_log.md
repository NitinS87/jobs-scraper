# Backend QA Audit Log

## Session: 2026-03-17

### Module: lib/uploader.js — processScraperResults()
- **Tested:** Static analysis of new upsert logic (update-on-duplicate), error handling, data consistency
- **Result:** FAIL — 4 bugs found (BUG-001 through BUG-004)
- **DB Verification:** No live DB test (scraper requires live Supabase credentials)
- **Changes Made:**
  - `lib/uploader.js:241-246` — Skip category re-insert when delete fails (BUG-004 fix)
  - `lib/uploader.js:51-56` — Changed company lookup from `.single()` to `.limit(1).maybeSingle()` (BUG-002 fix)
  - `lib/uploader.js:13-24` — Added error logging for source `last_synced_at` update, changed to `.maybeSingle()` (BUG-003 fix)
  - `lib/uploader.js:73-79` — Added error logging for company backfill update (BUG-003 fix)

### Module: lib/uploader.js — getOrCreateSource()
- **Tested:** Error handling on lookup and update
- **Result:** FAIL (BUG-003) — Fixed
- **Changes Made:** Added error capture on `last_synced_at` update, switched to `.maybeSingle()`

### Module: lib/uploader.js — getOrCreateCompany()
- **Tested:** Lookup behavior with `.ilike().single()`, error handling on backfill
- **Result:** FAIL (BUG-002, BUG-003) — Fixed
- **Changes Made:** Switched to `.limit(1).maybeSingle()`, added backfill error logging

### Module: lib/categoryMatcher.js
- **Tested:** Category loading and matching logic
- **Result:** PASS — No issues found

### Module: lib/descriptionParser.js
- **Tested:** Parsing logic for salary, skills, sections
- **Result:** PASS — No issues found

### Module: lib/logoUploader.js
- **Tested:** Error handling on download/upload
- **Result:** PASS — All failures logged and return null gracefully

### Module: lib/supabaseClient.js
- **Tested:** Client configuration
- **Result:** PASS — Uses service-role key (appropriate for backend scraper)

### BUG-001 Fix: Atomic transaction via Postgres RPC
- **Approach:** Created `sql/upsert_job_with_categories.sql` — a PL/pgSQL function that wraps job insert/update + category mapping delete + category mapping insert in a single transaction. If any step fails, everything rolls back.
- **Changes Made:**
  - `sql/upsert_job_with_categories.sql` — New Postgres function `upsert_job_with_categories(p_job, p_category_ids, p_existing_job_id)`
  - `lib/uploader.js:219-236` — Replaced 3 separate Supabase calls (update/insert + delete mappings + insert mappings) with a single `supabase.rpc('upsert_job_with_categories', ...)` call
- **Deployment required:** Run `sql/upsert_job_with_categories.sql` in Supabase SQL Editor before running scrapers

### Verification
- All fixes pass `node -c` syntax check
- Full verification requires:
  1. Deploy the RPC function via Supabase SQL Editor
  2. Run `node runScrapers.js` against live Supabase
