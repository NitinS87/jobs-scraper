-- Ingestion performance migration.
--
-- Prerequisite for the batched uploader in lib/uploader.js. Until this runs, the
-- uploader detects the missing schema and falls back to the old per-row path
-- (correct, just as expensive) — so it is safe to deploy the code first.
--
-- Run in the Supabase SQL editor. The CONCURRENTLY statements cannot run inside
-- a transaction block, so execute them one at a time, not as a single batch.

-- 1. Conflict target for the batched upsert, and the index the dedupe lookup
--    needs. Verify nothing violates it first — this must return zero rows:
--
--    select external_source, external_job_id, count(*)
--      from jobs group by 1, 2 having count(*) > 1;
--
--    (Checked 2026-09-08 against 18,293 live rows: 18,293 distinct pairs, 0 dupes.)

create unique index concurrently if not exists jobs_external_source_job_id_key
  on jobs (external_source, external_job_id);

alter table jobs
  add constraint jobs_external_source_job_id_key
  unique using index jobs_external_source_job_id_key;

-- 2. Lets a re-scrape skip rows whose content is byte-identical. Without it the
--    table is rewritten on every run: 713K write tuples against 18K live rows.
--    Existing rows start null, which the uploader treats as "must update", so
--    they self-heal on the first run after this migration.

alter table jobs add column if not exists content_hash text;

-- 3. getOrCreateCompany matches on lower(name); a plain btree on name cannot
--    serve that. Only needed for the per-company fallback path, but cheap.

create index concurrently if not exists companies_lower_name_idx
  on companies (lower(name));
