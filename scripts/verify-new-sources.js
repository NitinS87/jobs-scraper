#!/usr/bin/env node
// Verify that the 6 new scrapers populated Supabase correctly.
// Usage: node scripts/verify-new-sources.js
// Shows aggregates + 3 sample rows per source with their company + category mappings.

require('dotenv').config();
const supabase = require('../lib/supabaseClient');

const NEW_SOURCES = ['HNHiring', 'YCombinator', 'CutShort', 'NCS', 'Wellfound', 'SimplyHiredIN'];
const SAMPLE_SIZE = 3;

async function aggregate() {
  const summary = {};
  for (const src of NEW_SOURCES) {
    const stats = { total: 0, with_salary: 0, with_skills: 0, with_company: 0, with_country: 0, with_location: 0 };
    // Total count via head:true
    const { count: total } = await supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('external_source', src);
    stats.total = total || 0;
    if (stats.total === 0) { summary[src] = stats; continue; }

    const counters = [
      ['with_salary', { col: 'salary_min', op: 'not.is', val: null }],
      ['with_company', { col: 'company_id', op: 'not.is', val: null }],
      ['with_country', { col: 'country_code', op: 'not.is', val: null }],
      ['with_location', { col: 'location', op: 'not.is', val: null }],
    ];
    for (const [key, f] of counters) {
      const { count } = await supabase
        .from('jobs')
        .select('*', { count: 'exact', head: true })
        .eq('external_source', src)
        .not(f.col, 'is', f.val);
      stats[key] = count || 0;
    }
    // Skills (non-empty array): paginate to count
    let skillsCount = 0;
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('jobs')
        .select('skills', { count: 'exact' })
        .eq('external_source', src)
        .range(from, from + PAGE - 1);
      if (error) break;
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (Array.isArray(r.skills) && r.skills.length > 0) skillsCount++;
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
    stats.with_skills = skillsCount;
    summary[src] = stats;
  }
  return summary;
}

async function sampleSource(source) {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, title, external_job_id, source_url, posted_at, is_remote, location, country_code, job_type, experience_level, salary_min, salary_max, salary_currency, skills, summary, company_id')
    .eq('external_source', source)
    .order('created_at', { ascending: false })
    .limit(SAMPLE_SIZE);
  if (error) throw error;
  if (!jobs || jobs.length === 0) return [];

  const companyIds = [...new Set(jobs.map((j) => j.company_id).filter(Boolean))];
  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, logo_url, website, location, country_code')
    .in('id', companyIds.length ? companyIds : ['00000000-0000-0000-0000-000000000000']);
  const compMap = new Map((companies || []).map((c) => [c.id, c]));

  const jobIds = jobs.map((j) => j.id);
  const { data: mappings } = await supabase
    .from('job_category_mappings')
    .select('job_id, category_id')
    .in('job_id', jobIds);
  const catIds = [...new Set((mappings || []).map((m) => m.category_id))];
  const { data: cats } = await supabase
    .from('job_categories')
    .select('id, name')
    .in('id', catIds.length ? catIds : ['00000000-0000-0000-0000-000000000000']);
  const catMap = new Map((cats || []).map((c) => [c.id, c.name]));
  const jobCats = new Map();
  for (const m of mappings || []) {
    if (!jobCats.has(m.job_id)) jobCats.set(m.job_id, []);
    jobCats.get(m.job_id).push(catMap.get(m.category_id) || `?${m.category_id}`);
  }

  return jobs.map((j) => ({
    title: j.title,
    external_job_id: j.external_job_id,
    source_url: j.source_url,
    posted_at: j.posted_at,
    is_remote: j.is_remote,
    location: j.location,
    country_code: j.country_code,
    job_type: j.job_type,
    salary: j.salary_min ? `${j.salary_min}-${j.salary_max} ${j.salary_currency}` : null,
    skills: (j.skills || []).slice(0, 5),
    company: compMap.get(j.company_id) || null,
    categories: jobCats.get(j.id) || [],
    summary_first_120: (j.summary || '').slice(0, 120),
  }));
}

async function main() {
  console.log('=== Aggregate counts ===');
  const summary = await aggregate();
  for (const src of NEW_SOURCES) {
    const s = summary[src];
    if (!s) {
      console.log(`${src}: 0 rows in DB`);
      continue;
    }
    console.log(`${src}: total=${s.total} | salary=${s.with_salary} | skills=${s.with_skills} | company=${s.with_company} | country=${s.with_country} | location=${s.with_location}`);
  }

  for (const src of NEW_SOURCES) {
    const s = summary[src];
    if (!s) continue;
    console.log(`\n=== ${src} sample (${SAMPLE_SIZE} rows) ===`);
    const samples = await sampleSource(src);
    for (const r of samples) {
      console.log(JSON.stringify(r, null, 2));
      console.log('---');
    }
  }
}

main().catch((err) => {
  console.error('verify failed:', err.message);
  process.exit(1);
});
