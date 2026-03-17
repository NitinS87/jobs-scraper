-- Atomic job upsert with category mapping re-sync.
-- Postgres functions run inside a transaction: if any step fails, everything rolls back.
-- Deploy via Supabase SQL Editor or migration tool.

CREATE OR REPLACE FUNCTION upsert_job_with_categories(
  p_job JSONB,
  p_category_ids UUID[],
  p_existing_job_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_job_id UUID;
  v_action TEXT;
  v_update_fields JSONB;
BEGIN
  IF p_existing_job_id IS NOT NULL THEN
    -- UPDATE path: strip fields that should not be overwritten
    v_update_fields := p_job - 'is_active' - 'popular' - 'external_job_id' - 'external_source';

    -- Preserve posted_at/source_posted_at if new value is null
    IF (v_update_fields->>'posted_at') IS NULL THEN
      v_update_fields := v_update_fields - 'posted_at';
    END IF;
    IF (v_update_fields->>'source_posted_at') IS NULL THEN
      v_update_fields := v_update_fields - 'source_posted_at';
    END IF;

    -- Build and execute dynamic UPDATE from JSONB keys
    UPDATE jobs
    SET
      title = COALESCE(v_update_fields->>'title', title),
      company_id = CASE WHEN v_update_fields ? 'company_id' THEN (v_update_fields->>'company_id')::UUID ELSE company_id END,
      location = COALESCE(v_update_fields->>'location', location),
      is_remote = CASE WHEN v_update_fields ? 'is_remote' THEN (v_update_fields->>'is_remote')::BOOLEAN ELSE is_remote END,
      job_type = COALESCE(v_update_fields->>'job_type', job_type),
      experience_level = COALESCE(v_update_fields->>'experience_level', experience_level),
      description = COALESCE(v_update_fields->>'description', description),
      requirements = CASE WHEN v_update_fields ? 'requirements' THEN (v_update_fields->'requirements') ELSE requirements END,
      responsibilities = CASE WHEN v_update_fields ? 'responsibilities' THEN (v_update_fields->'responsibilities') ELSE responsibilities END,
      benefits = CASE WHEN v_update_fields ? 'benefits' THEN (v_update_fields->'benefits') ELSE benefits END,
      salary_min = CASE WHEN v_update_fields ? 'salary_min' THEN (v_update_fields->>'salary_min')::NUMERIC ELSE salary_min END,
      salary_max = CASE WHEN v_update_fields ? 'salary_max' THEN (v_update_fields->>'salary_max')::NUMERIC ELSE salary_max END,
      salary_currency = COALESCE(v_update_fields->>'salary_currency', salary_currency),
      skills = CASE WHEN v_update_fields ? 'skills' THEN (v_update_fields->'skills') ELSE skills END,
      posted_at = CASE WHEN v_update_fields ? 'posted_at' THEN (v_update_fields->>'posted_at')::TIMESTAMPTZ ELSE posted_at END,
      country_code = COALESCE(v_update_fields->>'country_code', country_code),
      visa_sponsorship = CASE WHEN v_update_fields ? 'visa_sponsorship' THEN (v_update_fields->>'visa_sponsorship')::BOOLEAN ELSE visa_sponsorship END,
      source_id = CASE WHEN v_update_fields ? 'source_id' THEN (v_update_fields->>'source_id')::UUID ELSE source_id END,
      source_url = COALESCE(v_update_fields->>'source_url', source_url),
      source_posted_at = CASE WHEN v_update_fields ? 'source_posted_at' THEN (v_update_fields->>'source_posted_at')::TIMESTAMPTZ ELSE source_posted_at END,
      summary = COALESCE(v_update_fields->>'summary', summary),
      highlights = CASE WHEN v_update_fields ? 'highlights' THEN (v_update_fields->'highlights') ELSE highlights END,
      required_qualifications = CASE WHEN v_update_fields ? 'required_qualifications' THEN (v_update_fields->'required_qualifications') ELSE required_qualifications END,
      preferred_qualifications = CASE WHEN v_update_fields ? 'preferred_qualifications' THEN (v_update_fields->'preferred_qualifications') ELSE preferred_qualifications END
    WHERE id = p_existing_job_id;

    v_job_id := p_existing_job_id;
    v_action := 'updated';

    -- Delete old category mappings
    DELETE FROM job_category_mappings WHERE job_id = v_job_id;

  ELSE
    -- INSERT path
    INSERT INTO jobs (
      title, company_id, location, is_remote, job_type, experience_level,
      description, requirements, responsibilities, benefits,
      salary_min, salary_max, salary_currency, skills,
      posted_at, is_active, external_job_id, external_source, popular,
      country_code, visa_sponsorship, source_id, source_url, source_posted_at,
      summary, highlights, required_qualifications, preferred_qualifications
    )
    VALUES (
      p_job->>'title',
      (p_job->>'company_id')::UUID,
      p_job->>'location',
      (p_job->>'is_remote')::BOOLEAN,
      p_job->>'job_type',
      p_job->>'experience_level',
      p_job->>'description',
      p_job->'requirements',
      p_job->'responsibilities',
      p_job->'benefits',
      (p_job->>'salary_min')::NUMERIC,
      (p_job->>'salary_max')::NUMERIC,
      p_job->>'salary_currency',
      p_job->'skills',
      (p_job->>'posted_at')::TIMESTAMPTZ,
      (p_job->>'is_active')::BOOLEAN,
      p_job->>'external_job_id',
      p_job->>'external_source',
      (p_job->>'popular')::BOOLEAN,
      p_job->>'country_code',
      (p_job->>'visa_sponsorship')::BOOLEAN,
      (p_job->>'source_id')::UUID,
      p_job->>'source_url',
      (p_job->>'source_posted_at')::TIMESTAMPTZ,
      p_job->>'summary',
      p_job->'highlights',
      p_job->'required_qualifications',
      p_job->'preferred_qualifications'
    )
    RETURNING id INTO v_job_id;

    v_action := 'inserted';
  END IF;

  -- Insert new category mappings (shared by both paths)
  IF array_length(p_category_ids, 1) > 0 THEN
    INSERT INTO job_category_mappings (job_id, category_id)
    SELECT v_job_id, unnest(p_category_ids);
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id, 'action', v_action);
END;
$$;
