# BUG-001: Non-atomic job update + category re-sync can leave jobs with zero categories

## Severity
High

## Layer
Database

## Reproduction
Run `node runScrapers.js` twice. If between the category mapping delete and the category mapping insert a network error or Supabase timeout occurs, the job ends up with no category mappings at all.

## Root Cause
`lib/uploader.js` lines 224-279: The update path performs three sequential Supabase calls — `jobs.update()`, `job_category_mappings.delete()`, `job_category_mappings.insert()` — without transaction wrapping. If the delete succeeds but the insert fails, the job loses all category associations. The job is still counted as `stats.updated++` with no error signal.

The same issue exists on insert: `jobs.insert()` then `job_category_mappings.insert()` are not atomic.

## Impact
Jobs silently lose category mappings over repeated scraper runs. The stats output shows a clean run. Only discoverable by manual DB inspection.

## Fix (implemented)
Created a Postgres RPC function `upsert_job_with_categories` (`sql/upsert_job_with_categories.sql`) that wraps all three operations in a single PL/pgSQL function. Postgres functions run in an implicit transaction — if any step raises an error, the entire function rolls back.

The JS uploader now calls `supabase.rpc('upsert_job_with_categories', { p_job, p_category_ids, p_existing_job_id })` instead of three separate Supabase client calls.

**Deployment:** Run `sql/upsert_job_with_categories.sql` in the Supabase SQL Editor before running scrapers.
