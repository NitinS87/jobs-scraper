-- Snapshot job_category_mappings before the taxonomy-driven matcher lands.
--
-- Run this BEFORE deploying the new lib/categoryScorer.js. The uploader
-- reconciles categories for unchanged jobs (lib/uploader.js), so the first run
-- after a matcher change emits deletes for every mapping the old keyword map
-- produced and the new rules do not — across 15,027 already-categorised jobs as
-- measured 2026-09-18. Set CATEGORY_ADDITIVE_ONLY=true for the first week as
-- well; this table is the belt to that pair of braces.
--
-- 18,318 rows at time of writing. Drop it once the new mappings are trusted.

CREATE TABLE IF NOT EXISTS job_category_mappings_backup_20260918 AS
SELECT * FROM job_category_mappings;

-- Verify before proceeding: this must report the same count as the live table.
--   SELECT
--     (SELECT count(*) FROM job_category_mappings)                    AS live,
--     (SELECT count(*) FROM job_category_mappings_backup_20260918)    AS backup;

-- Rollback, if the new matcher turns out to be wrong:
--   BEGIN;
--   DELETE FROM job_category_mappings;
--   INSERT INTO job_category_mappings SELECT * FROM job_category_mappings_backup_20260918;
--   COMMIT;
