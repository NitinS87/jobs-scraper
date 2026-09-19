const test = require('node:test');
const assert = require('node:assert');

const { isProfessionalRole, isLikelyEnglish } = require('../lib/jobFilter');

// Titles that must be INGESTED. Scope is taxonomy membership now, so this set
// deliberately includes the roots the old hand-written EXCLUDE_PATTERNS threw
// away — which is why Education and Training held 0 jobs and Healthcare held 3
// as of 2026-09-18 while their leaves sat unfilled.
const IN_SCOPE = [
  'Backend Engineer',
  'Senior Data Scientist',
  'Product Manager',
  'Marketing Manager',
  'Head of Marketing',
  'Financial Analyst',
  'Senior Accountant',
  'Paralegal',
  'Corporate Counsel',
  'Technical Recruiter',
  'Supply Chain Manager',
  // Healthcare leaves are scientific/biotech, not clinical.
  'Toxicologist',
  'Clinical Research Associate',
  'Regulatory Affairs Specialist',
  'Medical Writer',
  'Biomedical Engineer',
  // Education leaves include K-12 — "K-12" literally spans kindergarten upward.
  'Higher Education Teaching',
  'K-12 Teacher',
  'Kindergarten Teacher',
  'Corporate Training Manager',
  // Manufacturing leaves are engineering roles, not shop floor.
  'Mechanical Engineer',
  'Process Engineer',
  'Industrial Engineer',
  'Policy Analyst',
  'Environmental Engineer',
  'Civil Engineer',
];

// Titles that must be DROPPED: no leaf anywhere in the 392-node taxonomy.
// Confirmed still reachable by probing — FINN serves Sykepleier (nurse),
// Barnehage (kindergarten) and Butikkansatt (retail); Cimix serves
// hotel/restaurant, sanitation, crafts and transport categories.
const OUT_OF_SCOPE = [
  'Registered Nurse',
  'Dental Hygienist',
  'Head Chef',
  'Barista',
  'Truck Driver',
  'Office Cleaner',
  'Warehouse Worker',
  'Security Guard',
  'Hairdresser',
  'Preschool Assistant',
  'Nanny',
  'Amazon Fulfilment Associate',
  '',
  null,
  undefined,
];

test('in-scope titles are ingested', () => {
  const rejected = IN_SCOPE.filter((t) => !isProfessionalRole(t));
  assert.deepEqual(rejected, [], 'these titles map into the taxonomy and must not be dropped');
});

test('titles with no taxonomy home are dropped', () => {
  const accepted = OUT_OF_SCOPE.filter((t) => isProfessionalRole(t));
  assert.deepEqual(accepted, [], 'these titles have no leaf in the taxonomy and must be dropped');
});

test('scope agrees with the classifier', () => {
  // The filter and the matcher must not disagree: a job we ingest but cannot
  // classify becomes another uncategorised row, which is the exact problem this
  // work exists to fix (17,228 such rows measured 2026-09-18).
  const { matchCategoryIds } = require('../lib/categoryScorer');
  const taxonomy = require('../lib/taxonomy.generated.json');

  const disagreements = [];
  for (const title of IN_SCOPE) {
    if (isProfessionalRole(title) && matchCategoryIds(taxonomy, title).length === 0) {
      disagreements.push(title);
    }
  }
  assert.deepEqual(disagreements, [], 'ingested titles that the classifier cannot place');
});

test('isLikelyEnglish still rejects Scandinavian titles', () => {
  assert.equal(isLikelyEnglish('Backend Engineer'), true);
  assert.equal(isLikelyEnglish('Senior Software Engineer', 'We are looking for...'), true);
  assert.equal(isLikelyEnglish('Vi søker en erfaren utvikler'), false);
  assert.equal(isLikelyEnglish('Medarbejder til afdeling'), false);
  assert.equal(isLikelyEnglish(''), false);
});
