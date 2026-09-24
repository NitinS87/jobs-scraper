const test = require('node:test');
const assert = require('node:assert');

const {
  detectVisaSponsorship,
  detectExperienceLevel,
  parseDescription,
} = require('../lib/descriptionParser');

// ---------------------------------------------------------------------------
// Visa sponsorship — tri-state.
//
// Measured 2026-09-24 against the live corpus: the previous implementation was a
// bare /visa\s*(?:sponsor|support)/ test with no negation handling, and of 400
// active jobs flagged true, 299 had a negation within 40 characters. The filter
// was showing users jobs that explicitly refuse sponsorship.
// ---------------------------------------------------------------------------
const VISA_REFUSED = [
  // Both quoted verbatim from rows that were flagged as OFFERING sponsorship.
  'Visa Sponsorship  Employer will not sponsor applicants for employment',
  'This position is not open for Visa sponsorship or to existing Visa holders',
  'No visa sponsorship provided for this role',
  'Sponsorship is not available for this position',
  'We are unable to sponsor at this time',
  'Must be legally authorized to work in the US without sponsorship',
  'The company does not sponsor work visas',
  'Candidates must be eligible to work without visa sponsorship',
];

const VISA_OFFERED = [
  'Visa sponsorship is available.',
  'We offer relocation and visa support for the right candidate',
  'We sponsor H1B candidates',
  'Work permit support provided',
  'Visa Sponsorship: Yes',
  'Sponsorship is available for exceptional candidates',
];

const VISA_UNKNOWN = [
  'Great team, competitive salary, hybrid working',
  'You will build and ship features end to end.',
  '',
];

test('visa: refusals are never reported as sponsorship offered', () => {
  const wrong = VISA_REFUSED.filter((t) => detectVisaSponsorship(t) !== false);
  assert.deepEqual(wrong, [], 'these explicitly refuse sponsorship');
});

test('visa: genuine offers are detected', () => {
  const wrong = VISA_OFFERED.filter((t) => detectVisaSponsorship(t) !== true);
  assert.deepEqual(wrong, [], 'these offer sponsorship');
});

test('visa: silence is null, not false', () => {
  // false must mean "explicitly refuses". Collapsing "not mentioned" into false
  // is what made the filter unable to tell the two apart.
  const wrong = VISA_UNKNOWN.filter((t) => detectVisaSponsorship(t) !== null);
  assert.deepEqual(wrong, [], 'these do not mention sponsorship at all');
});

test('visa: a refusal wins even when offer-shaped words appear nearby', () => {
  const t = 'Visa sponsorship: we are not able to provide visa sponsorship for this role.';
  assert.equal(detectVisaSponsorship(t), false);
});

// ---------------------------------------------------------------------------
// Experience level
// ---------------------------------------------------------------------------
const EXPERIENCE = [
  ['We need a Senior Backend Engineer', 'SENIOR'],
  ['Staff Engineer, Platform', 'SENIOR'],
  ['Graduate programme for new joiners', 'ENTRY'],
  ['Working student, marketing', 'ENTRY'],
  ['Head of Product for our EMEA team', 'EXECUTIVE'],
  ['Mid-level position in our data team', 'MID'],
  // The years fallback is what recovers titles with no seniority word at all —
  // 12,329 of 47,022 active jobs had no level before it existed.
  ['You have 3+ years experience building web apps', 'MID'],
  ['Minimum 8 years of professional experience required', 'SENIOR'],
  ['1-2 years experience preferred', 'ENTRY'],
  ['5 to 7 years of relevant experience', 'MID'],
  ['Build great products with a great team', null],
];

test('experience level is inferred from seniority words and year ranges', () => {
  const failures = [];
  for (const [text, expected] of EXPERIENCE) {
    const got = detectExperienceLevel(text);
    if (got !== expected) failures.push(`  "${text}" -> ${got} (expected ${expected})`);
  }
  assert.equal(failures.length, 0, `experience inference regressed:\n${failures.join('\n')}`);
});

// ---------------------------------------------------------------------------
// job_type must not be invented
// ---------------------------------------------------------------------------
test('job_type stays null when the listing never states one', () => {
  // Every scraper used to end its chain with `|| 'FULL_TIME'`, which produced
  // 96.0% FULL_TIME across the corpus and made the Job Type filter meaningless.
  const parsed = parseDescription('<p>Join our team and build great software.</p>');
  assert.equal(parsed.job_type, null, 'an unstated type must be null, not FULL_TIME');
});

test('job_type is read when the listing does state one', () => {
  assert.equal(parseDescription('<p>This is a part-time role.</p>').job_type, 'PART_TIME');
  assert.equal(parseDescription('<p>6 month contract position.</p>').job_type, 'CONTRACT');
  assert.equal(parseDescription('<p>Summer internship programme.</p>').job_type, 'INTERNSHIP');
  assert.equal(parseDescription('<p>A full-time permanent position.</p>').job_type, 'FULL_TIME');
});
