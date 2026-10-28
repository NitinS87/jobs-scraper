const test = require('node:test');
const assert = require('node:assert');

const { parseJobPosting, slugId, listingUrl } = require('../scrapers/jobsinjapan');

// Trimmed from the live JobPosting JSON-LD on
// https://jobsinjapan.com/jobs/1192286/web-and-software-engineer/ (2026-10-28),
// after the site moved from WordPress to Next.js and the old `div.job-content-wrap`
// cards disappeared — the scraper returned 0 jobs from then on with no error.
const LD = {
  '@type': 'JobPosting',
  url: 'https://jobsinjapan.com/jobs/1192286/web-and-software-engineer/',
  title: 'Web and Software Engineer',
  description: '<ul><li>Visa sponsorship: Yes</li></ul><h3>Job Requirements</h3><ul><li>Java, Python</li></ul>',
  datePosted: '2026-10-13T04:28:58.167Z',
  employmentType: 'FULL_TIME',
  identifier: { '@type': 'PropertyValue', name: 'Foredge Corporation', value: '1192286' },
  hiringOrganization: {
    '@type': 'Organization',
    name: 'Foredge Corporation',
    url: 'https://jobsinjapan.com/companies/%E6%A0%AA%E5%BC%8F%E4%BC%9A%E7%A4%BEforedge/',
    sameAs: 'https://www.foredge.co.jp/',
    logo: 'https://media.jobsinjapan.com/legacy/2023/08/Foredge.png',
  },
  industry: 'Information Technology, Internet, Telecommunications',
  jobLocation: {
    '@type': 'Place',
    address: { addressLocality: 'Chiyoda-ku', addressRegion: 'Tokyo', postalCode: '100-0005', addressCountry: 'JP' },
  },
  baseSalary: {
    '@type': 'MonetaryAmount',
    currency: 'JPY',
    value: { '@type': 'QuantitativeValue', minValue: 230000, maxValue: 350000, unitText: 'MONTH' },
  },
};

test('a JobPosting maps onto the standard job shape', () => {
  const job = parseJobPosting(LD);
  assert.equal(job.title, 'Web and Software Engineer');
  assert.equal(job.source_url, LD.url);
  assert.equal(job.external_source, 'JobsInJapan');
  assert.equal(job.posted_at, '2026-10-13T04:28:58.167Z');
  assert.equal(job.job_type, 'FULL_TIME');
  assert.equal(job.location, 'Chiyoda-ku, Tokyo');
  assert.equal(job.country_code, 'JP');
  assert.deepEqual([job.salary_min, job.salary_max, job.salary_currency], [230000, 350000, 'JPY']);
  assert.match(job.description, /Job Requirements/);
  assert.deepEqual(job.company, {
    name: 'Foredge Corporation',
    website: 'https://www.foredge.co.jp/',
    logo_url: null,
    country_code: 'JP',
  });
});

test('external_job_id stays the URL slug, so pre-redesign rows dedupe', () => {
  // Rows written before the redesign used the last path segment, e.g.
  // 'adas-development-project-supervisor-2'. Switching to the numeric id would
  // re-insert every job still listed.
  assert.equal(parseJobPosting(LD).external_job_id, 'web-and-software-engineer');
  assert.equal(
    slugId('https://jobsinjapan.com/jobs/1731020/adas-development-project-supervisor-2/'),
    'adas-development-project-supervisor-2',
  );
});

test('non-ASCII slugs match the stored lowercase-escaped form whatever the input encoding', () => {
  const stored = 'real-estate-rental-coordinator%e3%80%80%e8%b3%83%e8%b2%b8';
  assert.equal(slugId('/jobs/1731949/real-estate-rental-coordinator%E3%80%80%E8%B3%83%E8%B2%B8/'), stored);
  assert.equal(slugId('/jobs/1731949/real-estate-rental-coordinator　賃貸/'), stored);
  assert.equal(slugId(`/jobs/1731949/${stored}/`), stored);
});

test('remote roles are flagged and a missing salary stays null', () => {
  const job = parseJobPosting({
    ...LD, title: 'Remote Backend Engineer', baseSalary: undefined, jobLocationType: 'TELECOMMUTE',
  });
  assert.equal(job.is_remote, true);
  assert.equal(job.salary_min, null);
  assert.equal(job.salary_currency, null);
});

test('anything that is not a usable JobPosting is rejected', () => {
  assert.equal(parseJobPosting(null), null);
  assert.equal(parseJobPosting({ '@type': 'WebPage', title: 'x', url: LD.url }), null);
  assert.equal(parseJobPosting({ ...LD, title: '' }), null);
});

test('listing pages follow the site pagination scheme', () => {
  assert.equal(listingUrl(1), 'https://jobsinjapan.com/jobs/?sort=latest');
  assert.equal(listingUrl(3), 'https://jobsinjapan.com/jobs/page/3/?sort=latest');
});
