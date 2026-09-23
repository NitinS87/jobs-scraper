const supabase = require('./supabaseClient');
const { matchCategories } = require('./categoryMatcher');
const { syncCategoryMappings } = require('./categoryMappingWriter');
const { downloadAndUploadLogo, tryExtractLogo, getGoogleFavicon } = require('./logoUploader');
const { parseDescription, parseExperienceLevelFromTitle, stripHtml, parseSalaryText } = require('./descriptionParser');
const {
  contentHash,
  classifyJob,
  planCategorySync,
  stripUnwritableOnUpdate,
  chunk,
  chunkByUrlBudget,
  groupByKeySignature,
} = require('./uploadPlanner');

const companyCache = new Map(); // lower(name) → company_id
const sourceCache = new Map(); // name → source_id

const LOOKUP_CHUNK_SIZE = 500;
const WRITE_CHUNK_SIZE = Number(process.env.WRITE_CHUNK_SIZE) || 500;
// Floor for the halving retry below; under this a timeout is a real failure.
const MIN_WRITE_CHUNK_SIZE = 25;
const PAGE_SIZE = 1000;

// Conflict target from sql/001_ingestion_perf.sql.
const JOB_CONFLICT_TARGET = 'external_source,external_job_id';

/**
 * Schema capabilities, probed once per process. sql/001_ingestion_perf.sql is
 * applied out of band, so the uploader has to work either side of it: without
 * the migration it degrades to the old per-row path rather than erroring out
 * mid-run against the live pipeline.
 */
const schema = { probed: false, hasContentHash: false, hasJobUpsert: true };

async function probeSchema() {
  if (schema.probed) return schema;
  schema.probed = true;

  const { error } = await supabase.from('jobs').select('id, content_hash').limit(1);
  if (error) {
    schema.hasContentHash = false;
    console.warn(
      'jobs.content_hash is missing — every existing row will be rewritten on every run. '
      + 'Apply sql/001_ingestion_perf.sql to enable no-op skipping.'
    );
  } else {
    schema.hasContentHash = true;
  }
  return schema;
}

/** PostgREST reports a missing ON CONFLICT target as Postgres 42P10. */
/** Postgres cancels a statement that runs past statement_timeout (57014). */
function isStatementTimeout(error) {
  if (!error) return false;
  return error.code === '57014'
    || /canceling statement due to statement timeout/i.test(error.message || '');
}

function isMissingConflictTarget(error) {
  return error && (error.code === '42P10' || /no unique or exclusion constraint/i.test(error.message || ''));
}

async function getOrCreateSource(source) {
  const { name, source_type, base_url } = source;
  if (sourceCache.has(name)) return sourceCache.get(name);

  const { data: existing } = await supabase
    .from('job_sources')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (existing) {
    const { error: syncError } = await supabase
      .from('job_sources')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (syncError) console.warn(`Failed to update last_synced_at for source ${name}: ${syncError.message}`);
    sourceCache.set(name, existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from('job_sources')
    .insert({
      name,
      source_type: source_type || 'SCRAPER',
      base_url: base_url || null,
      is_active: true,
      last_synced_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create source ${name}: ${error.message}`);
  sourceCache.set(name, created.id);
  return created.id;
}

/**
 * Load every company id keyed by lower(name), in pages, once per process.
 *
 * This replaces one round-trip per uncached company (~460 per run, 392K over the
 * measured window). Only id and name are fetched — 5,969 rows is roughly 150 KB
 * on the wire, against ~460 requests at ~1.15 KB each, and it reproduces the old
 * ilike() semantics exactly because the key is lowercased in JS.
 */
async function primeCompanyCache() {
  if (companyCache.size > 0) return;

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      // Non-fatal: an empty cache just means we fall back to per-company lookups.
      console.warn(`Company prefetch failed, falling back to per-company lookups: ${error.message}`);
      return;
    }
    for (const row of data || []) {
      if (row.name) companyCache.set(row.name.toLowerCase(), row.id);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
}

/**
 * Enrichment columns for the companies this run actually touches. Kept separate
 * from primeCompanyCache so the wide columns are fetched for ~460 companies
 * rather than all 5,969.
 */
async function fetchCompanyDetails(ids) {
  const details = new Map();
  for (const slice of chunkByUrlBudget(ids, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('companies')
      .select('id, logo_url, website, location, industry, country_code, description')
      .in('id', slice);

    if (error) {
      console.warn(`Company detail fetch failed: ${error.message}`);
      continue;
    }
    for (const row of data || []) details.set(row.id, row);
  }
  return details;
}

/** Backfill null columns on an existing company from freshly scraped data. */
async function backfillCompany(existing, company) {
  const updates = {};

  if (!existing.logo_url && company.logo_url) {
    const storageUrl = await downloadAndUploadLogo(company.logo_url, company.name);
    if (storageUrl) updates.logo_url = storageUrl;
  }

  // Overwrite website when the stored value is not a URL (a company name was
  // stored there by mistake in early runs).
  const existingWebsiteIsValid = existing.website && /^https?:\/\//.test(existing.website);
  if (!existingWebsiteIsValid && company.website) updates.website = company.website;
  if (!existing.location && company.location) updates.location = company.location;
  if (!existing.industry && company.industry) updates.industry = company.industry;
  if (!existing.country_code && company.country_code) updates.country_code = company.country_code;
  if (!existing.description && company.description) updates.description = company.description;

  if (Object.keys(updates).length === 0) return;

  const { error } = await supabase.from('companies').update(updates).eq('id', existing.id);
  if (error) console.warn(`Failed to backfill company ${company.name}: ${error.message}`);
}

async function resolveLogo(company) {
  let logoStorageUrl = null;
  if (company.logo_url) {
    logoStorageUrl = await downloadAndUploadLogo(company.logo_url, company.name);
  }
  if (!logoStorageUrl && company.website) {
    const extracted = await tryExtractLogo(company.website);
    if (extracted) logoStorageUrl = await downloadAndUploadLogo(extracted, company.name);
  }
  if (!logoStorageUrl && company.website) {
    try {
      const domain = new URL(
        company.website.startsWith('http') ? company.website : `https://${company.website}`
      ).hostname;
      logoStorageUrl = await getGoogleFavicon(domain, company.name);
    } catch {}
  }
  // Last resort: guess a domain from the company name.
  if (!logoStorageUrl && company.name) {
    const guessed = `${company.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`;
    logoStorageUrl = await getGoogleFavicon(guessed, company.name);
  }
  return logoStorageUrl;
}

async function getOrCreateCompany(company, details) {
  if (!company || !company.name || company.name === 'Not Mentioned') return null;

  const key = company.name.toLowerCase();

  if (companyCache.has(key)) {
    const id = companyCache.get(key);
    const existing = details && details.get(id);
    if (existing) await backfillCompany(existing, company);
    return id;
  }

  // Cache miss on a primed cache means the company is genuinely new.
  const logoStorageUrl = await resolveLogo(company);

  const { data: created, error } = await supabase
    .from('companies')
    .insert({
      name: company.name,
      website: company.website || null,
      logo_url: logoStorageUrl,
      location: company.location || null,
      industry: company.industry || null,
      country_code: company.country_code || null,
      is_active: true,
      is_verified: false,
      company_type: company.company_type || 'DIRECT_EMPLOYER',
    })
    .select('id')
    .single();

  if (error) {
    console.warn(`Failed to create company ${company.name}: ${error.message}`);
    return null;
  }

  companyCache.set(key, created.id);
  return created.id;
}

/**
 * One batched pass to find which of these jobs already exist, their stored
 * content hash, and their current category mappings. Replaces a SELECT per job.
 *
 * Returns `degraded: true` if any chunk query failed, in which case the caller
 * must fall back to per-job lookups — guessing "not found" here would insert
 * duplicates.
 */
async function prefetchExisting(jobs, hasContentHash) {
  const existingById = new Map();
  const existingCategories = new Map();

  if (!jobs.length) return { existingById, existingCategories, degraded: false };

  const externalSource = jobs[0].external_source;
  const ids = [...new Set(jobs.map((j) => String(j.external_job_id)))];
  const columns = hasContentHash ? 'id, external_job_id, content_hash' : 'id, external_job_id';

  for (const slice of chunkByUrlBudget(ids, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('jobs')
      .select(columns)
      .eq('external_source', externalSource)
      .in('external_job_id', slice);

    if (error) {
      console.warn(`Batched job lookup failed: ${error.message}`);
      return { existingById, existingCategories, degraded: true };
    }
    for (const row of data || []) {
      existingById.set(String(row.external_job_id), { id: row.id, content_hash: row.content_hash || null });
    }
  }

  const jobIds = [...existingById.values()].map((v) => v.id);
  for (const slice of chunkByUrlBudget(jobIds, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('job_category_mappings')
      .select('job_id, category_id')
      .in('job_id', slice);

    if (error) {
      // Non-fatal: without this we simply re-sync every mapping as before.
      console.warn(`Batched category-mapping lookup failed: ${error.message}`);
      existingCategories.clear();
      break;
    }
    for (const row of data || []) {
      if (!existingCategories.has(row.job_id)) existingCategories.set(row.job_id, new Set());
      existingCategories.get(row.job_id).add(row.category_id);
    }
  }

  return { existingById, existingCategories, degraded: false };
}

function buildJobRecord(job, companyId, sourceId) {
  const parsed = parseDescription(job.description || '');

  const experienceLevel = job.experience_level
    || parseExperienceLevelFromTitle(job.title)
    || parsed.experience_level;

  let salaryMin = job.salary_min || (parsed.salary ? parsed.salary.min : null);
  let salaryMax = job.salary_max || (parsed.salary ? parsed.salary.max : null);
  let salaryCurrency = job.salary_currency || (parsed.salary ? parsed.salary.currency : null);

  if (!salaryMin && job.salary_text) {
    const fromText = parseSalaryText(job.salary_text);
    if (fromText) {
      salaryMin = fromText.min;
      salaryMax = fromText.max;
      salaryCurrency = fromText.currency;
    }
  }

  return {
    title: job.title,
    company_id: companyId,
    location: job.location || (job.is_remote ? 'Remote' : 'Not specified'),
    is_remote: job.is_remote || false,
    job_type: job.job_type || parsed.job_type,
    experience_level: experienceLevel,
    description: job.description || '',
    requirements: job.requirements || parsed.requirements,
    responsibilities: job.responsibilities || parsed.responsibilities,
    benefits: job.benefits || parsed.benefits,
    salary_min: salaryMin,
    salary_max: salaryMax,
    salary_currency: salaryCurrency,
    skills: job.skills || parsed.skills,
    posted_at: job.posted_at || null,
    is_active: true,
    external_job_id: job.external_job_id,
    external_source: job.external_source,
    popular: false,
    country_code: job.country_code || null,
    visa_sponsorship: job.visa_sponsorship || parsed.visa_sponsorship || false,
    source_id: sourceId,
    source_url: job.source_url || null,
    source_posted_at: job.posted_at || null,
    summary: job.summary || parsed.summary || stripHtml(job.description).substring(0, 200),
    highlights: job.highlights || parsed.highlights,
    required_qualifications: job.required_qualifications || parsed.required_qualifications,
    preferred_qualifications: job.preferred_qualifications || parsed.preferred_qualifications,
  };
}

/**
 * Bulk-write one bucket of job records.
 *
 * Inserts and updates go in separate batches on purpose: an upsert carrying
 * is_active/popular would overwrite them, resurrecting every row the 90-day
 * expiry job has deactivated (8,404 of 18,293 at time of writing). Updates omit
 * those columns entirely so ON CONFLICT DO UPDATE never touches them.
 *
 * No .select() anywhere — supabase-js only sends Prefer: return=representation
 * when you chain one, so these come back 204 with an empty body.
 */
async function writeJobBatch(records, stats, label) {
  if (!records.length) return true;

  // Grouped by key signature first: PostgREST rejects a bulk payload whose
  // objects have different keys, and updates drop posted_at only when null.
  for (const group of groupByKeySignature(records)) {
    for (const slice of chunk(group, WRITE_CHUNK_SIZE)) {
      const { error } = await supabase
        .from('jobs')
        .upsert(slice, { onConflict: JOB_CONFLICT_TARGET, ignoreDuplicates: false });

      if (error) {
        if (isMissingConflictTarget(error)) return false;

        // A 500-row batch of ~9 KB rows can exceed Postgres's statement timeout
        // under backfill load. Measured 2026-09-23: three batches died this way
        // and 1,500 already-scraped jobs were discarded. Halve and retry rather
        // than throw the work away — the rows are fine, the batch was just too
        // big for one statement.
        if (isStatementTimeout(error) && slice.length > MIN_WRITE_CHUNK_SIZE) {
          console.warn(
            `Batched job ${label} hit a statement timeout at ${slice.length} rows — retrying in halves`,
          );
          const half = Math.ceil(slice.length / 2);
          const ok = await writeJobBatch(slice.slice(0, half), stats, label)
            && await writeJobBatch(slice.slice(half), stats, label);
          if (!ok) return false;
          continue;
        }

        console.warn(`Batched job ${label} failed (${slice.length} rows): ${error.message}`);
        stats.errors += slice.length;
        continue;
      }
      stats[label === 'insert' ? 'inserted' : 'updated'] += slice.length;
    }
  }
  return true;
}

async function processScraperResults(jobs) {
  const stats = { inserted: 0, updated: 0, unchanged: 0, errors: 0 };

  if (!jobs || jobs.length === 0) return stats;

  const { hasContentHash } = await probeSchema();

  const firstJob = jobs[0];
  const sourceId = await getOrCreateSource({
    name: firstJob.external_source,
    source_type: firstJob.source_type || 'SCRAPER',
    base_url: firstJob.source_base_url || null,
  });

  await primeCompanyCache();

  const { existingById, existingCategories, degraded } = await prefetchExisting(jobs, hasContentHash);
  if (degraded) {
    console.warn('Batched existence lookup failed — falling back to per-job lookups for this source.');
  }

  // Enrichment columns only for companies this run touches.
  const touchedCompanyIds = [...new Set(
    jobs
      .map((j) => j.company && j.company.name && companyCache.get(j.company.name.toLowerCase()))
      .filter(Boolean)
  )];
  const companyDetails = await fetchCompanyDetails(touchedCompanyIds);

  const toInsert = [];
  const toUpdate = [];
  const categoryPlans = [];
  // Categories for not-yet-inserted jobs, keyed by external identity. Kept out
  // of the record itself so no bogus column reaches PostgREST.
  const pendingCategories = new Map();

  for (const job of jobs) {
    try {
      let existing = null;
      if (degraded) {
        const { data, error: lookupError } = await supabase
          .from('jobs')
          .select(hasContentHash ? 'id, content_hash' : 'id')
          .eq('external_source', job.external_source)
          .eq('external_job_id', job.external_job_id)
          .maybeSingle();

        if (lookupError) {
          console.warn(`Failed to check for existing job "${job.title}": ${lookupError.message}`);
          stats.errors++;
          continue;
        }
        existing = data ? { id: data.id, content_hash: data.content_hash || null } : null;
      } else {
        existing = existingById.get(String(job.external_job_id)) || null;
      }

      const companyId = await getOrCreateCompany(job.company, companyDetails);
      const categoryIds = await matchCategories(job.title, job.categories || []);

      const record = buildJobRecord(job, companyId, sourceId);
      const verdict = classifyJob({ existing, record, hasContentHash });

      if (hasContentHash) record.content_hash = contentHash(record);

      if (verdict === 'insert') {
        toInsert.push(record);
        if (categoryIds.length) {
          pendingCategories.set(`${record.external_source} ${record.external_job_id}`, categoryIds);
        }
      } else if (verdict === 'update') {
        toUpdate.push(stripUnwritableOnUpdate(record));
      } else {
        stats.unchanged++;
      }

      // Category mappings still need reconciling for an unchanged job: the
      // keyword map can change without the job content changing.
      if (existing) {
        const plan = planCategorySync(categoryIds, existingCategories.get(existing.id));
        if (!plan.unchanged) categoryPlans.push({ jobId: existing.id, ...plan });
      }
    } catch (err) {
      console.error(`Error processing job "${job.title}": ${err.message}`);
      stats.errors++;
    }
  }

  const updatesOk = await writeJobBatch(toUpdate, stats, 'update');
  const insertsOk = await writeJobBatch(toInsert, stats, 'insert');

  if (!updatesOk || !insertsOk) {
    console.warn(
      `No unique constraint on jobs (${JOB_CONFLICT_TARGET}) — falling back to per-row writes. `
      + 'Apply sql/001_ingestion_perf.sql to enable batched upserts.'
    );
    schema.hasJobUpsert = false;
    await writeJobsPerRow(toInsert, toUpdate, stats);
  }

  // New jobs get their mappings after the insert, once ids exist.
  if (pendingCategories.size > 0) {
    const insertedIds = await resolveInsertedIds(toInsert);
    for (const [key, categoryIds] of pendingCategories) {
      const jobId = insertedIds.get(key);
      if (jobId) categoryPlans.push({ jobId, toInsert: categoryIds, toDelete: [] });
    }
  }

  await syncCategoryMappings(categoryPlans, stats);

  return stats;
}

/** Last-resort path when the unique constraint is absent. */
async function writeJobsPerRow(toInsert, toUpdate, stats) {
  stats.inserted = 0;
  stats.updated = 0;

  for (const record of toUpdate) {
    const { error } = await supabase
      .from('jobs')
      .update(record)
      .eq('external_source', record.external_source)
      .eq('external_job_id', record.external_job_id);
    if (error) {
      console.warn(`Failed to update job "${record.title}": ${error.message}`);
      stats.errors++;
    } else {
      stats.updated++;
    }
  }

  for (const record of toInsert) {
    const { error } = await supabase.from('jobs').insert(record);
    if (error) {
      console.warn(`Failed to insert job "${record.title}": ${error.message}`);
      stats.errors++;
    } else {
      stats.inserted++;
    }
  }
}

/** Resolve ids for freshly inserted jobs in one batched pass per source. */
async function resolveInsertedIds(records) {
  const out = new Map();
  if (!records.length) return out;

  const externalSource = records[0].external_source;
  const ids = records.map((r) => String(r.external_job_id));

  for (const slice of chunkByUrlBudget(ids, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, external_source, external_job_id')
      .eq('external_source', externalSource)
      .in('external_job_id', slice);

    if (error) {
      // Returning early here loses the category mappings for every job in this
      // batch, with no other signal — so make the consequence explicit.
      console.error(
        `Failed to resolve inserted job ids (${error.message}) — `
        + `${records.length} newly inserted jobs will have no category mappings.`,
      );
      return out;
    }
    for (const row of data || []) {
      out.set(`${row.external_source} ${row.external_job_id}`, row.id);
    }
  }
  return out;
}

module.exports = { processScraperResults };
