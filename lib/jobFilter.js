// Scope filter for the multi-vertical boards (Teal, JobStairs, EnglishJobs,
// FINN, JobbSafari, GulfTalent, Cimix, WorkInDenmark, SourcingXpress). Those
// boards carry the whole labour market; this decides what we ingest.
//
// Scope is defined by the Supabase taxonomy, not by a hand-written allowlist:
// a role is in scope if the classifier can place it somewhere in the 392-node
// tree. That is the same rule the frontend browses by, so the two cannot drift.
//
// The previous hand-written EXCLUDE/INCLUDE lists are gone. They predated the
// taxonomy and actively contradicted it — they dropped `nurse`, `teacher`,
// `machine operator` and `welder`, which is why Education and Training held 0
// jobs and Healthcare held 3 as of 2026-09-18, while the taxonomy's Healthcare
// leaves (Clinical Research Associate, Toxicologist, Regulatory Affairs
// Specialist) and Education leaves (Higher Education Teaching, K-12 Teaching)
// went unfilled.
const taxonomy = require('./taxonomy.generated.json');
const { scoreTitle } = require('./categoryScorer');

// Roles with no home anywhere in the taxonomy. Kept as an explicit ingestion
// gate rather than relying solely on the classifier returning nothing, because
// the two have different lifecycles: this decides INGESTION, categoryRules.js's
// REJECT_PATTERNS decides CLASSIFICATION. Confirmed still necessary by probing
// the boards — FINN exposes Sykepleier (nurse), Barnehage (kindergarten) and
// Butikkansatt (retail); Cimix exposes hotel/restaurant, sanitation, crafts and
// transport categories.
const NO_TAXONOMY_HOME = [
  /\bnurse\b|\bnursing\b|\bmidwife\b|\bcaregiver\b|\bcare\s*(?:assistant|worker)\b/i,
  /\bdentist\b|\bdental\b|\bphysician\b|\bsurgeon\b|\bpharmacist\b|\bveterinar/i,
  /\bchef\b|\bcook\b|\bbaker\b|\bbutcher\b|\bbarista\b|\bbartender\b|\bwaiter\b|\bwaitress\b/i,
  /\bhairdresser\b|\bbarber\b|\bbeautician\b|\bmasseur\b|\bmassage\b/i,
  /\bdriver\b|\bchauffeur\b|\bcourier\b|\btrucker\b|\bforklift\b/i,
  /\bcleaner\b|\bcleaning\b|\bjanitor\b|\bhousekeep|\bmaid\b|\blaundry\b/i,
  /\bwarehouse\s+(?:worker|operative)\b|\bpicker\b|\bpacker\b|\bfactory\s*worker\b/i,
  /\bcashier\b|\bcheckout\b|\bshop\s*assistant\b/i,
  /\bsecurity\s*guard\b|\bwatchman\b|\bbouncer\b/i,
  /\bbabysitter\b|\bnanny\b|\bpreschool\b|\bdaycare\b/i,
  /\bfarm\s*(?:hand|worker)\b|\bfisher|\bharvest/i,
];

/**
 * True when the title maps somewhere into the job_categories taxonomy.
 *
 * Synchronous and DB-free: it reads the committed taxonomy snapshot, so the
 * nine scrapers that call it per candidate stay free of network round-trips.
 */
function isProfessionalRole(title) {
  if (!title) return false;
  const t = String(title);

  for (const re of NO_TAXONOMY_HOME) {
    if (re.test(t)) return false;
  }

  return scoreTitle(taxonomy, t).length > 0;
}

// Common Scandinavian / German stopwords that rarely appear in English titles.
// Note: deliberately excludes tokens that collide with English (e.g. "for").
const NON_ENGLISH_STOPWORDS = /\b(og|eller|med|til|søger|søges|medarbejder|erfaren|och|för|att|ett|samt|inom|söker|ledig\s+stilling|stilling|tjeneste|virksomhed|afdeling|kommune|sykepleier|ansvarlig|vår|våre)\b/i;

const NORDIC_CHARS = /[æøåäöÆØÅÄÖ]/g;

/**
 * Heuristic English-language check on a title (and optional description).
 * Rejects text with frequent Nordic characters or Scandinavian stopwords.
 * Conservative: when ambiguous, treats text as English to avoid dropping
 * legitimate English listings that merely contain a place name.
 */
function isLikelyEnglish(title, description = '') {
  const titleStr = String(title || '');
  if (!titleStr.trim()) return false;

  // Strong signal: Scandinavian stopwords in the title.
  if (NON_ENGLISH_STOPWORDS.test(titleStr)) return false;

  // Nordic-character density across title + a slice of the description.
  const sample = `${titleStr} ${String(description || '').slice(0, 600)}`;
  const letters = (sample.match(/[a-zA-ZæøåäöÆØÅÄÖ]/g) || []).length;
  const nordic = (sample.match(NORDIC_CHARS) || []).length;
  if (letters > 0 && nordic / letters > 0.04) return false;

  // Stopwords anywhere in the sampled description.
  if (description && NON_ENGLISH_STOPWORDS.test(String(description).slice(0, 600))) return false;

  return true;
}

module.exports = { isProfessionalRole, isLikelyEnglish };
