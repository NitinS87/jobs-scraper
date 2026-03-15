const supabase = require('./supabaseClient');
const { matchCategories } = require('./categoryMatcher');
const { downloadAndUploadLogo, tryExtractLogo, getGoogleFavicon } = require('./logoUploader');
const { parseDescription, parseExperienceLevelFromTitle, stripHtml, parseSalaryText } = require('./descriptionParser');

const companyCache = new Map(); // lower(name) → company_id
const sourceCache = new Map(); // name → source_id

async function getOrCreateSource(source) {
  const { name, source_type, base_url } = source;
  if (sourceCache.has(name)) return sourceCache.get(name);

  const { data: existing } = await supabase
    .from('job_sources')
    .select('id')
    .eq('name', name)
    .single();

  if (existing) {
    await supabase
      .from('job_sources')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', existing.id);
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

async function getOrCreateCompany(company) {
  if (!company || !company.name || company.name === 'Not Mentioned') return null;

  const key = company.name.toLowerCase();
  if (companyCache.has(key)) return companyCache.get(key);

  const { data: existing } = await supabase
    .from('companies')
    .select('id, logo_url, website, location, industry, country_code, description')
    .ilike('name', key)
    .single();

  if (existing) {
    const updates = {};

    // Backfill logo if missing
    if (!existing.logo_url && company.logo_url) {
      const storageUrl = await downloadAndUploadLogo(company.logo_url, company.name);
      if (storageUrl) updates.logo_url = storageUrl;
    }

    // Backfill other fields if null in DB but provided by scraper
    if (!existing.website && company.website) updates.website = company.website;
    if (!existing.location && company.location) updates.location = company.location;
    if (!existing.industry && company.industry) updates.industry = company.industry;
    if (!existing.country_code && company.country_code) updates.country_code = company.country_code;
    if (!existing.description && company.description) updates.description = company.description;

    if (Object.keys(updates).length > 0) {
      await supabase
        .from('companies')
        .update(updates)
        .eq('id', existing.id);
    }

    companyCache.set(key, existing.id);
    return existing.id;
  }

  // Try to get a logo: direct URL → website scrape → Google favicon
  let logoStorageUrl = null;
  if (company.logo_url) {
    logoStorageUrl = await downloadAndUploadLogo(company.logo_url, company.name);
  }
  if (!logoStorageUrl && company.website) {
    const extracted = await tryExtractLogo(company.website);
    if (extracted) {
      logoStorageUrl = await downloadAndUploadLogo(extracted, company.name);
    }
  }
  if (!logoStorageUrl && company.website) {
    try {
      const domain = new URL(company.website.startsWith('http') ? company.website : `https://${company.website}`).hostname;
      logoStorageUrl = await getGoogleFavicon(domain, company.name);
    } catch {}
  }
  // Last resort: guess domain from company name for Google favicon
  if (!logoStorageUrl && company.name) {
    const guessedDomain = company.name.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/\s+/g, '') + '.com';
    logoStorageUrl = await getGoogleFavicon(guessedDomain, company.name);
  }

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

async function processScraperResults(jobs) {
  const stats = { inserted: 0, skipped: 0, errors: 0, companies_created: 0 };

  if (!jobs || jobs.length === 0) return stats;

  // Ensure source exists
  const firstJob = jobs[0];
  const sourceId = await getOrCreateSource({
    name: firstJob.external_source,
    source_type: firstJob.source_type || 'SCRAPER',
    base_url: firstJob.source_base_url || null,
  });

  for (const job of jobs) {
    try {
      // Check for duplicate
      const { data: existing } = await supabase
        .from('jobs')
        .select('id')
        .eq('external_source', job.external_source)
        .eq('external_job_id', job.external_job_id)
        .single();

      if (existing) {
        stats.skipped++;
        continue;
      }

      // Parse description for additional fields
      const parsed = parseDescription(job.description || '');

      // Resolve company
      const companyId = await getOrCreateCompany(job.company);

      // Match categories
      const categoryIds = await matchCategories(job.title, job.categories || []);

      // Determine experience level: explicit > title-parsed > description-parsed
      const experienceLevel = job.experience_level
        || parseExperienceLevelFromTitle(job.title)
        || parsed.experience_level;

      // Build job record
      const jobRecord = {
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
        salary_min: job.salary_min || (parsed.salary ? parsed.salary.min : null),
        salary_max: job.salary_max || (parsed.salary ? parsed.salary.max : null),
        salary_currency: job.salary_currency || (parsed.salary ? parsed.salary.currency : null),
        ...(() => {
          // If salary still null and salary_text exists, try parsing it
          const hasSalary = job.salary_min || (parsed.salary && parsed.salary.min);
          if (!hasSalary && job.salary_text) {
            const fromText = parseSalaryText(job.salary_text);
            if (fromText) return { salary_min: fromText.min, salary_max: fromText.max, salary_currency: fromText.currency };
          }
          return {};
        })(),
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

      const { data: inserted, error } = await supabase
        .from('jobs')
        .insert(jobRecord)
        .select('id')
        .single();

      if (error) {
        console.warn(`Failed to insert job "${job.title}": ${error.message}`);
        stats.errors++;
        continue;
      }

      // Insert category mappings
      if (categoryIds.length > 0 && inserted) {
        const mappings = categoryIds.map(catId => ({
          job_id: inserted.id,
          category_id: catId,
        }));

        const { error: mapError } = await supabase
          .from('job_category_mappings')
          .insert(mappings);

        if (mapError) {
          console.warn(`Failed to map categories for "${job.title}": ${mapError.message}`);
        }
      }

      stats.inserted++;
    } catch (err) {
      console.error(`Error processing job "${job.title}": ${err.message}`);
      stats.errors++;
    }
  }

  return stats;
}

module.exports = { processScraperResults };
