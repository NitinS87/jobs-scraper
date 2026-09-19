const test = require('node:test');
const assert = require('node:assert');

const taxonomy = require('../lib/taxonomy.generated.json');
const {
  THRESHOLD,
  MAX_CATEGORIES,
  normaliseTitle,
  coreOf,
  buildIndex,
  scoreTitle,
  matchCategoryIds,
} = require('../lib/categoryScorer');

const rootOf = (title) => {
  const r = scoreTitle(taxonomy, title);
  return r.length ? r[0].root : null;
};

// ---------------------------------------------------------------------------
// Golden set: title -> expected ROOT category.
//
// Seeded from titles sampled out of the live corpus on 2026-09-18, when 53% of
// all jobs (17,228 of 32,255) had zero category mappings and 251 of 392
// categories were unused. Testing the 93 old KEYWORD_MAP regexes against 60 of
// those real titles showed 80% matched no pattern at all.
// ---------------------------------------------------------------------------
const GOLDEN = [
  // --- Software/Internet/AI -------------------------------------------------
  ['Advanced Software Engineer', 'Software/Internet/AI'],
  ['Software Development Engineer', 'Software/Internet/AI'],
  ['Back End Engineer', 'Software/Internet/AI'],
  ['Backend Developer', 'Software/Internet/AI'],
  ['Front End Developer', 'Software/Internet/AI'],
  ['Full Stack Engineer', 'Software/Internet/AI'],
  ['developer', 'Software/Internet/AI'],
  ['Founding Engineer', 'Software/Internet/AI'],
  ['Senior React Developer', 'Software/Internet/AI'],
  ['Python Engineer', 'Software/Internet/AI'],
  ['Java Backend Developer', 'Software/Internet/AI'],
  ['Golang Engineer', 'Software/Internet/AI'],
  ['.NET Developer', 'Software/Internet/AI'],
  ['Android Developer', 'Software/Internet/AI'],
  ['iOS Engineer', 'Software/Internet/AI'],
  ['Flutter Developer', 'Software/Internet/AI'],
  ['Data Analyst - Analytics Foundations', 'Software/Internet/AI'],
  ['Senior Data Scientist', 'Software/Internet/AI'],
  ['Data Engineer', 'Software/Internet/AI'],
  ['Machine Learning Engineer', 'Software/Internet/AI'],
  ['Computer Vision Engineer', 'Software/Internet/AI'],
  ['MLOps Engineer', 'Software/Internet/AI'],
  ['LLM Engineer', 'Software/Internet/AI'],
  ['AI Engineer', 'Software/Internet/AI'],
  ['DevOps Engineer', 'Software/Internet/AI'],
  ['Devsecops Engineer Mid', 'Software/Internet/AI'],
  ['Head of Platform Engineering', 'Software/Internet/AI'],
  ['Cloud Operations Engineer', 'Software/Internet/AI'],
  ['Site Reliability Engineer', 'Software/Internet/AI'],
  ['Cyber Security Engineer', 'Software/Internet/AI'],
  ['Security Analyst', 'Software/Internet/AI'],
  ['Database Administrator', 'Software/Internet/AI'],
  ['System Administrator', 'Software/Internet/AI'],
  ['IT Support Specialist', 'Software/Internet/AI'],
  ['Help Desk Technician', 'Software/Internet/AI'],
  ['QA Manager', 'Software/Internet/AI'],
  ['Automation Test Engineer', 'Software/Internet/AI'],
  ['Engineering Manager Heartbeat AI (m/f/d)', 'Software/Internet/AI'],
  ['Engineering Director', 'Software/Internet/AI'],
  ['CTO', 'Software/Internet/AI'],
  ['Software Architect', 'Software/Internet/AI'],
  ['Developer Relations Engineer', 'Software/Internet/AI'],
  ['Technical Account Manager (US Remote)', 'Software/Internet/AI'],
  ['Technical Writer', 'Software/Internet/AI'],
  ['Scrum Master', 'Software/Internet/AI'],
  ['Blockchain Engineer', 'Software/Internet/AI'],
  ['Unity Developer', 'Software/Internet/AI'],
  ['Game Developer', 'Software/Internet/AI'],
  ['Salesforce Developer', 'Software/Internet/AI'],
  ['ETL Developer', 'Software/Internet/AI'],
  ['Power BI Developer', 'Software/Internet/AI'],
  ['Business Intelligence Analyst', 'Software/Internet/AI'],

  // --- Product --------------------------------------------------------------
  ['Product Manager', 'Product'],
  ['Director of Product Management', 'Product'],
  ['Senior Product Owner', 'Product'],
  ['Technical Product Manager', 'Product'],
  ['AI Product Manager', 'Product'],
  ['Product Analyst', 'Product'],
  ['Game Designer', 'Product'],

  // --- Creative & Design ----------------------------------------------------
  ['Senior Product Designer', 'Creative & Design'],
  ['UX Designer', 'Creative & Design'],
  ['UI Designer', 'Creative & Design'],
  ['UX Researcher', 'Creative & Design'],
  ['Graphic Designer', 'Creative & Design'],
  ['Motion Designer', 'Creative & Design'],
  ['Video Editor', 'Creative & Design'],
  ['Creative Director', 'Creative & Design'],
  ['3D Artist', 'Creative & Design'],
  ['Interior Designer', 'Creative & Design'],

  // --- Marketing ------------------------------------------------------------
  ['Brand Manager', 'Marketing'],
  ['Community Manager', 'Marketing'],
  ['Growth Marketing Manager', 'Marketing'],
  ['Performance Marketing Manager', 'Marketing'],
  ['Email Marketing Specialist', 'Marketing'],
  ['Product Marketing Manager', 'Marketing'],
  ['Content Marketing Manager', 'Marketing'],
  ['Copywriter', 'Marketing'],
  ['SEO Specialist', 'Marketing'],
  ['Social Media Manager', 'Marketing'],
  ['Public Relations Manager', 'Marketing'],
  ['Market Development Manager', 'Marketing'],
  ['Event Marketing Specialist', 'Marketing'],

  // --- Sales ----------------------------------------------------------------
  ['Business Development Manager', 'Sales'],
  ['Senior Account Executive - Enterprise', 'Sales'],
  ['Sales Development Representative', 'Sales'],
  ['Inside Sales Representative', 'Sales'],
  ['Sales Manager / Germany Mid Market', 'Sales'],
  ['Regional Sales Manager', 'Sales'],
  ['VP of Sales', 'Sales'],
  ['Sales Operations Specialist', 'Sales'],
  ['Sales Executive', 'Sales'],
  ['Sales Associate', 'Sales'],
  ['Enterprise Sales Manager', 'Sales'],
  ['Partnerships Manager', 'Sales'],
  ['Medical Device Sales Representative', 'Sales'],
  ['Store Manager', 'Sales'],
  ['Financial Advisor', 'Sales'],

  // --- Customer Service -----------------------------------------------------
  ['Customer Success Manager', 'Customer Service'],
  ['Customer Care Associate', 'Customer Service'],
  ['Customer Support Specialist', 'Customer Service'],
  ['Customer Service Representative', 'Customer Service'],

  // --- Finance --------------------------------------------------------------
  ['Financial Analyst', 'Finance'],
  ['Finance Manager', 'Finance'],
  ['Investment Banker', 'Finance'],
  ['Credit Reports Officer', 'Finance'],
  ['Portfolio Manager', 'Finance'],
  ['Quantitative Analyst', 'Finance'],
  ['Actuary', 'Finance'],
  ['Underwriter', 'Finance'],
  ['Equity Research Analyst', 'Finance'],
  ['Investor Relations Manager', 'Finance'],
  ['Treasury Analyst', 'Finance'],

  // --- Accounting -----------------------------------------------------------
  ['Senior Accountant', 'Accounting'],
  ['Strategic Finance Controller', 'Accounting'],
  ['Internal Auditor', 'Accounting'],
  ['Tax Specialist', 'Accounting'],
  ['Bookkeeper', 'Accounting'],

  // --- HR / Admin / Legal ---------------------------------------------------
  ['Manager, Talent Acquisition - Interpath Advisory', 'Human Resource/Administrative/Legal'],
  ['HR Business Partner', 'Human Resource/Administrative/Legal'],
  ['Employee Relations Business Partner', 'Human Resource/Administrative/Legal'],
  ['Human Resource Manager', 'Human Resource/Administrative/Legal'],
  ['Payroll Specialist', 'Human Resource/Administrative/Legal'],
  ['Technical Recruiter', 'Human Resource/Administrative/Legal'],
  ['Executive Assistant', 'Human Resource/Administrative/Legal'],
  ['Office Manager', 'Human Resource/Administrative/Legal'],
  ['Receptionist', 'Human Resource/Administrative/Legal'],
  ['Data Entry Clerk', 'Human Resource/Administrative/Legal'],
  ['Chief of Staff', 'Human Resource/Administrative/Legal'],
  ['Counsel, Privacy, AI & Data Protection', 'Human Resource/Administrative/Legal'],

  // --- Legal Services -------------------------------------------------------
  ['Compliance Specialist', 'Legal Services'],
  ['Paralegal', 'Legal Services'],
  ['Legal Assistant', 'Legal Services'],
  ['Legal Operations Manager', 'Legal Services'],
  ['Litigation Associate', 'Legal Services'],
  ['Intellectual Property Lawyer', 'Legal Services'],
  ['Immigration Attorney', 'Legal Services'],
  ['Court Clerk', 'Legal Services'],

  // --- Consulting -----------------------------------------------------------
  ['Senior Strategy Manager', 'Consulting'],
  ['Business Strategy Consultant', 'Consulting'],
  ['Change Management Consultant', 'Consulting'],
  ['Market Research Analyst', 'Consulting'],
  ['SAP EWM Consultant', 'Consulting'],
  ['SAP Basis & Cloud Consultant (m/f/d)', 'Consulting'],
  ['Business Analyst', 'Consulting'],
  ['M&A Consultant', 'Consulting'],

  // --- Healthcare (scientific / biotech) ------------------------------------
  ['Toxicologist', 'Healthcare'],
  ['Biochemist', 'Healthcare'],
  ['Pharmacologist', 'Healthcare'],
  ['Clinical Research Associate', 'Healthcare'],
  ['Clinical Research Scientist', 'Healthcare'],
  ['Regulatory Affairs Specialist', 'Healthcare'],
  ['Medical Writer', 'Healthcare'],
  ['Biomedical Engineer', 'Healthcare'],
  ['Biostatistician', 'Healthcare'],
  ['Healthcare Data Scientist', 'Healthcare'],
  ['Clinical Operations Manager', 'Healthcare'],
  ['Formulation Scientist', 'Healthcare'],

  // --- Education and Training -----------------------------------------------
  ['Higher Education Teaching', 'Education and Training'],
  ['Postdoctoral Researcher in Nutrition and Metabolism', 'Education and Training'],
  ['PhD Scholarship in Sustainable Coatings', 'Education and Training'],
  ['Lecturer in Computer Science', 'Education and Training'],
  ['Corporate Training Manager', 'Education and Training'],
  ['Instructional Designer', 'Education and Training'],
  ['K-12 Teacher', 'Education and Training'],
  ['Academic Dean', 'Education and Training'],

  // --- Public Sector and Government -----------------------------------------
  ['Policy Analyst', 'Public Sector and Government'],
  ['Government Relations Manager', 'Public Sector and Government'],
  ['Fundraising Coordinator', 'Public Sector and Government'],
  ['Volunteer Coordinator', 'Public Sector and Government'],

  // --- Logistics / Supply Chain ---------------------------------------------
  ['Supply Chain Manager', 'Logistics/Supply Chain'],
  ['Process Manager Logistic (m/f/d)', 'Logistics/Supply Chain'],
  ['Procurement Manager', 'Logistics/Supply Chain'],
  ['Inventory Manager', 'Logistics/Supply Chain'],
  ['Facilities Manager', 'Logistics/Supply Chain'],
  ['Warehouse Manager', 'Logistics/Supply Chain'],

  // --- Production / Manufacturing -------------------------------------------
  ['Mechanical Engineer', 'Production/Manufacturing'],
  ['Phantom Works Experienced Industrial Engineer', 'Production/Manufacturing'],
  ['Manufacturing Engineer', 'Production/Manufacturing'],
  ['Process Engineer Product Lifecycle Data Management', 'Production/Manufacturing'],
  ['Mechatronics Engineer', 'Production/Manufacturing'],
  ['Chemical Engineer', 'Production/Manufacturing'],
  ['Operations Supervisor', 'Production/Manufacturing'],
  ['EHS Engineer', 'Production/Manufacturing'],
  ['Laboratory Technician', 'Production/Manufacturing'],
  ['Powertrain Engineer', 'Production/Manufacturing'],

  // --- Electrical Engineering -----------------------------------------------
  ['Electrical Engineer', 'Electrical Engineering'],
  ['Embedded Software Engineer', 'Electrical Engineering'],
  ['Firmware Engineer', 'Electrical Engineering'],
  ['FPGA Engineer', 'Electrical Engineering'],
  ['ASIC Design Engineer', 'Electrical Engineering'],
  ['RF Engineer', 'Electrical Engineering'],
  ['Hardware Engineer', 'Electrical Engineering'],
  ['Robotics Engineer', 'Electrical Engineering'],
  ['Aerospace Engineer', 'Electrical Engineering'],
  ['Field Application Engineer', 'Electrical Engineering'],
  ['Telecommunications Engineer', 'Electrical Engineering'],
  ['Automation Engineer', 'Electrical Engineering'],

  // --- Energy / Environmental -----------------------------------------------
  ['Energy Engineer', 'Energy/Environmental'],
  ['Renewable Energy Engineer', 'Energy/Environmental'],
  ['Power Systems Engineer', 'Energy/Environmental'],
  ['Environmental Engineer', 'Energy/Environmental'],
  ['Environmental Scientist', 'Energy/Environmental'],
  ['Nuclear Engineer', 'Energy/Environmental'],

  // --- Real Estate / Architecture -------------------------------------------
  ['Civil Engineer', 'Real Estate/Architecture'],
  ['Structural Engineer', 'Real Estate/Architecture'],
  ['Urban Planner', 'Real Estate/Architecture'],
  ['Landscape Architect', 'Real Estate/Architecture'],
  ['Construction Project Manager', 'Real Estate/Architecture'],
  ['Property Manager', 'Real Estate/Architecture'],
];

// Titles that must classify to NOTHING. Pins "no fallback category, ever" —
// an "Other" bucket would instantly become the largest category and is strictly
// worse than null for a filter UI.
const NEGATIVE = [
  'Amazon Fulfilment Associate',
  'Amazon Fulfillment Associate',
  'Sorting Associate',
  'Picker / Packer',
  'Delivery Boy Biker',
  'NYC - Hiring',
  'Stellar Science - Hiring',
  "We're hiring!",
  'Talent Pool',
  'Open Application',
  'Registered Nurse',
  'Head Chef',
  'Security Guard',
  'Truck Driver',
  'Office Cleaner',
  'Hairdresser',
  'Barista',
  '',
  '   ',
];

// Normalisation pairs: raw title -> the token-bearing core we expect to survive.
const NORMALISATION = [
  ['Software Engineer (m/f/d)', 'software engineer'],
  ['Data Analyst (d/f/m)', 'data analyst'],
  ['DevOps Engineer (m/w/d)', 'devops engineer'],
  ['Process Engineer (All Genders)', 'process engineer'],
  ['Back End Engineer', 'backend engineer'],
  ['Front-End Developer', 'frontend developer'],
  ['Full Stack Engineer', 'fullstack engineer'],
  ['Senior Software Engineer', 'software engineer'],
  ['Lead Data Scientist', 'data scientist'],
  ['Working Student Marketing', 'marketing'],
];

test('golden set: every title resolves to its expected root', () => {
  const failures = [];
  for (const [title, expected] of GOLDEN) {
    const got = rootOf(title);
    if (got !== expected) failures.push(`  ${title}\n     expected: ${expected}\n     got:      ${got}`);
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length}/${GOLDEN.length} golden titles regressed:\n${failures.join('\n')}`,
  );
});

test('negative set: unclassifiable titles return no categories', () => {
  const failures = [];
  for (const title of NEGATIVE) {
    const got = scoreTitle(taxonomy, title);
    if (got.length) failures.push(`  "${title}" -> ${got.map((g) => g.name).join(', ')}`);
  }
  assert.equal(failures.length, 0, `titles that must not classify did:\n${failures.join('\n')}`);
});

test('normalisation strips gender tags, seniority and compound splits', () => {
  const failures = [];
  for (const [raw, expected] of NORMALISATION) {
    const { segments } = normaliseTitle(raw);
    const got = coreOf(segments[0]);
    if (got !== expected) failures.push(`  "${raw}" -> "${got}" (expected "${expected}")`);
  }
  assert.equal(failures.length, 0, `normalisation regressed:\n${failures.join('\n')}`);
});

test('every leaf name referenced by categoryRules.js resolves in the taxonomy', () => {
  // The old KEYWORD_MAP resolved names at runtime and silently dropped any that
  // did not match, so a renamed category degraded coverage with no signal.
  const { unresolvedRules } = buildIndex(taxonomy);
  assert.deepEqual(unresolvedRules, [], 'rules point at category names that do not exist');
});

test('taxonomy.generated.json is the shape the scorer indexes', () => {
  assert.equal(taxonomy.counts.leaves, taxonomy.leaves.length, 'counts.leaves must match the array');
  assert.ok(taxonomy.leaves.length > 250, `expected ~288 leaves, got ${taxonomy.leaves.length}`);
  assert.equal(taxonomy.counts.roots, taxonomy.roots.length, 'counts.roots must match the array');

  const ids = new Set(taxonomy.leaves.map((l) => l.id));
  assert.equal(ids.size, taxonomy.leaves.length, 'leaf ids must be unique');

  const missing = taxonomy.leaves.filter((l) => !l.group || !l.root || !l.id || !l.name);
  assert.deepEqual(missing, [], 'every leaf needs id, name, group and root');
});

test('scoring is deterministic across repeated and reordered input', () => {
  // Five leaf names collide once the parenthetical disambiguator is stripped
  // (Project/Program Manager x3, Network Engineer, Paralegal, Risk Analyst,
  // Sales Engineer). Without a stable tie-break these flip between ids
  // run-to-run and planCategorySync emits an insert+delete pair per job on
  // every 6-hourly run, forever.
  const probes = ['Paralegal', 'Risk Analyst', 'Network Engineer', 'Sales Engineer', 'Project Manager'];
  for (const title of probes) {
    const a = matchCategoryIds(taxonomy, title);
    const b = matchCategoryIds(taxonomy, title);
    assert.deepEqual(a, b, `"${title}" must score identically on repeat`);
  }

  const withCats = matchCategoryIds(taxonomy, 'Backend Engineer', ['design', 'product']);
  const reordered = matchCategoryIds(taxonomy, 'Backend Engineer', ['product', 'design']);
  assert.deepEqual(withCats, reordered, 'sourceCategories order must not change the result');
});

test('never returns more than MAX_CATEGORIES', () => {
  // Measured 2026-09-18: the old additive-Set matcher put 13 categories on one
  // job and more than 3 on 212 jobs.
  const offenders = [];
  for (const [title] of GOLDEN) {
    const n = matchCategoryIds(taxonomy, title).length;
    if (n > MAX_CATEGORIES) offenders.push(`${title} -> ${n}`);
  }
  assert.deepEqual(offenders, [], `titles exceeding ${MAX_CATEGORIES} categories`);
});

test('every returned id is a real leaf', () => {
  const leafIds = new Set(taxonomy.leaves.map((l) => l.id));
  const bad = [];
  for (const [title] of GOLDEN) {
    for (const id of matchCategoryIds(taxonomy, title)) {
      if (!leafIds.has(id)) bad.push(`${title} -> ${id}`);
    }
  }
  assert.deepEqual(bad, [], 'scorer returned ids that are not leaves');
});

test('scores below the threshold are never emitted', () => {
  for (const [title] of GOLDEN) {
    for (const hit of scoreTitle(taxonomy, title)) {
      assert.ok(hit.score >= THRESHOLD, `${title}: ${hit.name} scored ${hit.score} < ${THRESHOLD}`);
    }
  }
});

test('null and non-string titles are handled without throwing', () => {
  assert.deepEqual(matchCategoryIds(taxonomy, null), []);
  assert.deepEqual(matchCategoryIds(taxonomy, undefined), []);
  assert.deepEqual(matchCategoryIds(taxonomy, 12345), []);
  assert.deepEqual(matchCategoryIds(taxonomy, 'Backend Engineer', null).length > 0, true);
});
