-- Ingestion performance migration.
--
-- APPLIED 2026-09-08 to ApplymintAI (pidjubyaqzoitmbixzbf) as migration
-- `ingestion_perf_upsert_target_and_content_hash`. Kept here for the record and
-- for rebuilding a comparable environment.
--
-- CONCURRENTLY was dropped: the Supabase migration runner executes inside a
-- transaction, where it is illegal, and at 18,887 rows a plain index build is
-- sub-second. Restore CONCURRENTLY (running each statement outside a transaction)
-- if this is ever replayed against a substantially larger table.

-- 1. Conflict target for the batched upsert, and the index the dedupe lookup
--    needs. Verified immediately before applying: 0 duplicate pairs across
--    18,887 rows, 0 null keys, no pre-existing unique constraint.
--
--    Pre-flight check -- must return zero rows:
--      select external_source, external_job_id, count(*)
--        from jobs group by 1, 2 having count(*) > 1;

create unique index if not exists jobs_external_source_job_id_key
  on jobs (external_source, external_job_id);

alter table jobs
  add constraint jobs_external_source_job_id_key
  unique using index jobs_external_source_job_id_key;

-- 2. Lets a re-scrape skip rows whose content is byte-identical. Existing rows
--    start null, which the uploader treats as "must update", so they self-heal
--    on the first run after this migration.

alter table jobs add column if not exists content_hash text;

-- 3. getOrCreateCompany matches on lower(name); a plain btree on name cannot
--    serve that. Only used by the per-company fallback path, but cheap.

create index if not exists companies_lower_name_idx on companies (lower(name));
