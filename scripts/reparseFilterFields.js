/**
 * Re-derive the filter fields from descriptions already stored in the database.
 *
 * Audited 2026-09-24 against 47,022 active jobs:
 *   - visa_sponsorship was INVERTED. Detection was one regex with no negation
 *     handling, so a refusal ("Employer will not sponsor applicants") was
 *     flagged as an offer. On a 1,000-row sample, 40 of 42 flags were wrong.
 *   - job_type was 96.0% FULL_TIME because every scraper ended its chain with
 *     `|| 'FULL_TIME'`, so an unparsed type became full time.
 *   - experience_level was 26% null.
 *
 * Fixing the parsers only corrects rows a scraper revisits. Descriptions are
 * already in the database, so this corrects the whole corpus without touching a
 * single website.
 *
 * Usage:
 *   node scripts/reparseFilterFields.js                 # DRY RUN (default)
 *   node scripts/reparseFilterFields.js --execute
 *   node scripts/reparseFilterFields.js --source Teal
 *   node scripts/reparseFilterFields.js --limit 2000
 *   node scripts/reparseFilterFields.js --active-only
 *
 * Only ever writes job_type, experience_level and visa_sponsorship. Never
 * touches is_active, popular, posted_at or content_hash.
 */
require('dotenv').config({ quiet: true });
const supabase = require('../lib/supabaseClient');
const {
  stripHtml,
  detectVisaSponsorship,
  detectExperienceLevel,
  parseDescription,
  parseExperienceLevelFromTitle,
} = require('../lib/descriptionParser');

// Descriptions average ~9 KB, so a 500-row page is a ~4.5 MB read and Postgres
// cancelled it with a statement timeout partway through the first full pass.
const PAGE_SIZE = Number(process.env.REPARSE_PAGE_SIZE) || 150;
const READ_RETRIES = 4;
const WRITE_CHUNK = 4000;
const ID_CHUNK = 300; // .in() lists ride in the query string

function parseArgs(argv) {
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    execute: argv.includes('--execute'),
    activeOnly: argv.includes('--active-only'),
    source: val('--source'),
    limit: Number(val('--limit')) || Infinity,
    afterId: val('--after-id') || '',
  };
}

/** Recompute the three filter fields for one stored row. */
function derive(job) {
  const text = stripHtml(job.description || '');
  const parsed = parseDescription(job.description || '');

  return {
    // null when the listing never states a type — no more FULL_TIME default.
    job_type: parsed.job_type || null,
    experience_level: parseExperienceLevelFromTitle(job.title)
      || detectExperienceLevel(text)
      || null,
    // Tri-state: true offered, false explicitly refused, null not mentioned.
    visa_sponsorship: detectVisaSponsorship(text),
  };
}

const changed = (a, b) => a.job_type !== b.job_type
  || a.experience_level !== b.experience_level
  || a.visa_sponsorship !== b.visa_sponsorship;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`reparse: ${args.execute ? 'EXECUTE' : 'DRY RUN'}`
    + `${args.source ? ` source=${args.source}` : ''}${args.activeOnly ? ' active-only' : ''}`);

  const stats = {
    scanned: 0, changed: 0, written: 0, errors: 0,
    jobTypeCleared: 0, expGained: 0,
    visaFalsePositives: 0, visaNowRefused: 0, visaNowOffered: 0,
  };
  const samples = [];
  let cursor = args.afterId;
  let pending = [];

  // Batch by VALUE, not by row. A partial update cannot go through PostgREST's
  // bulk upsert (it would null the columns we do not send), but the three
  // derived fields only take ~90 distinct combinations across the whole corpus,
  // so every row sharing a combination can be updated in ONE request with
  // .in('id', [...]). A first version PATCHed per row and managed ~150 rows/min,
  // which is 5+ hours and ~60k requests against a project whose whole batching
  // effort exists to keep request counts down.
  const flush = async () => {
    if (!pending.length || !args.execute) { pending = []; return; }

    const groups = new Map();
    for (const row of pending) {
      const key = `${row.job_type}|${row.experience_level}|${row.visa_sponsorship}`;
      if (!groups.has(key)) {
        groups.set(key, {
          values: {
            job_type: row.job_type,
            experience_level: row.experience_level,
            visa_sponsorship: row.visa_sponsorship,
          },
          ids: [],
        });
      }
      groups.get(key).ids.push(row.id);
    }

    for (const { values, ids } of groups.values()) {
      // PostgREST puts .in() lists in the query string, so cap by URL length.
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const slice = ids.slice(i, i + ID_CHUNK);
        const { error } = await supabase.from('jobs').update(values).in('id', slice);
        if (error) {
          stats.errors += slice.length;
          if (stats.errors <= slice.length * 3) console.warn(`  update failed (${slice.length} rows): ${error.message}`);
        } else {
          stats.written += slice.length;
        }
      }
    }
    pending = [];
  };

  for (;;) {
    let q = supabase
      .from('jobs')
      .select('id, title, description, job_type, experience_level, visa_sponsorship')
      .order('id');
    if (cursor) q = q.gt('id', cursor);
    if (args.source) q = q.eq('external_source', args.source);
    if (args.activeOnly) q = q.eq('is_active', true);

    // A statement timeout on the read used to abort the whole pass and leave the
    // corpus half-corrected. Retry with a smaller page instead.
    let data = null;
    for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
      const size = Math.max(25, Math.floor(PAGE_SIZE / (2 ** attempt)));
      const res = await q.limit(size);
      if (!res.error) { data = res.data; break; }
      if (!/statement timeout|57014/i.test(res.error.message)) {
        throw new Error(`read failed: ${res.error.message}`);
      }
      console.warn(`  read timed out at ${size} rows — retrying smaller`);
      if (attempt === READ_RETRIES - 1) throw new Error('read failed: timed out at minimum page size');
    }
    if (!data || !data.length) break;

    for (const job of data) {
      if (stats.scanned >= args.limit) break;
      stats.scanned += 1;

      const before = {
        job_type: job.job_type,
        experience_level: job.experience_level,
        visa_sponsorship: job.visa_sponsorship,
      };
      const after = derive(job);
      if (!changed(before, after)) continue;

      stats.changed += 1;
      if (before.job_type === 'FULL_TIME' && after.job_type === null) stats.jobTypeCleared += 1;
      if (!before.experience_level && after.experience_level) stats.expGained += 1;
      if (before.visa_sponsorship === true && after.visa_sponsorship !== true) stats.visaFalsePositives += 1;
      if (after.visa_sponsorship === false) stats.visaNowRefused += 1;
      if (after.visa_sponsorship === true) stats.visaNowOffered += 1;

      if (samples.length < 12 && before.visa_sponsorship === true && after.visa_sponsorship !== true) {
        samples.push(`  ${job.title.slice(0, 52).padEnd(52)} visa ${before.visa_sponsorship} -> ${after.visa_sponsorship}`);
      }

      pending.push({ id: job.id, ...after });
      if (pending.length >= WRITE_CHUNK) await flush();
    }

    cursor = data[data.length - 1].id;
    if (data.length < PAGE_SIZE || stats.scanned >= args.limit) break;
  }
  await flush();

  console.log(`\nscanned=${stats.scanned} changed=${stats.changed} `
    + `${args.execute ? `written=${stats.written}` : '(dry run)'} errors=${stats.errors}`);
  console.log(`  job_type FULL_TIME -> null : ${stats.jobTypeCleared}`);
  console.log(`  experience_level gained    : ${stats.expGained}`);
  console.log(`  visa false positives fixed : ${stats.visaFalsePositives}`);
  console.log(`  visa now explicitly refused: ${stats.visaNowRefused}`);
  console.log(`  visa now genuinely offered : ${stats.visaNowOffered}`);
  if (samples.length) {
    console.log('\nsample visa corrections:');
    samples.forEach((s) => console.log(s));
  }
  if (!args.execute) console.log('\nDRY RUN — nothing written. Re-run with --execute.');
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
