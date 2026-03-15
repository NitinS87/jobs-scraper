const cheerio = require('cheerio');

const TECH_KEYWORDS = [
  'javascript', 'typescript', 'python', 'java', 'golang', 'go', 'ruby', 'rust',
  'c\\+\\+', 'c#', '\\.net', 'php', 'swift', 'kotlin', 'scala', 'elixir', 'haskell',
  'react', 'angular', 'vue', 'svelte', 'next\\.js', 'nuxt', 'node\\.js', 'express',
  'django', 'flask', 'fastapi', 'rails', 'spring', 'laravel',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ansible',
  'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'cassandra',
  'graphql', 'rest api', 'grpc', 'kafka', 'rabbitmq',
  'machine learning', 'deep learning', 'nlp', 'computer vision', 'pytorch', 'tensorflow',
  'html', 'css', 'sass', 'tailwind', 'webpack', 'vite',
  'git', 'ci/cd', 'jenkins', 'github actions', 'circleci',
  'linux', 'unix', 'bash', 'sql', 'nosql',
  'figma', 'sketch', 'adobe', 'photoshop', 'illustrator',
  'agile', 'scrum', 'jira', 'confluence',
  'solidity', 'web3', 'blockchain', 'ethereum',
];

const TECH_REGEX = new RegExp(`\\b(${TECH_KEYWORDS.join('|')})\\b`, 'gi');

const SALARY_PATTERNS = [
  /\$\s?([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/i,
  /USD\s?([\d,]+)\s*[-–—to]+\s*([\d,]+)/i,
  /EUR\s?([\d,]+)\s*[-–—to]+\s*([\d,]+)/i,
  /AED\s?([\d,]+)\s*[-–—to]+\s*([\d,]+)/i,
  /([\d,]+)\s*[-–—to]+\s*([\d,]+)\s*(?:USD|EUR|GBP|AED)/i,
];

const SECTION_PATTERNS = {
  requirements: /requirements|qualifications|what you('ll)? need|must have|minimum qualifications|who you are|what we('re)? looking for/i,
  responsibilities: /responsibilities|what you('ll)? do|your role|the role|key duties|about the role/i,
  benefits: /benefits|perks|what we offer|why join|compensation|we provide/i,
  preferred: /nice to have|preferred|bonus|ideal|plus|desirable/i,
};

function parseDescription(html) {
  if (!html) {
    return {
      requirements: [],
      responsibilities: [],
      benefits: [],
      skills: [],
      salary: null,
      summary: '',
      highlights: [],
      required_qualifications: [],
      preferred_qualifications: [],
      job_type: null,
      experience_level: null,
      visa_sponsorship: false,
    };
  }

  const $ = cheerio.load(html);
  const plainText = $.text().replace(/\s+/g, ' ').trim();

  // Extract sections by heading
  const sections = { requirements: [], responsibilities: [], benefits: [], preferred: [] };

  $('h1, h2, h3, h4, h5, h6, strong, b').each((_, el) => {
    const headingText = $(el).text().trim();
    let matchedSection = null;

    for (const [section, pattern] of Object.entries(SECTION_PATTERNS)) {
      if (pattern.test(headingText)) {
        matchedSection = section;
        break;
      }
    }

    if (!matchedSection) return;

    // Collect list items after this heading
    let next = $(el).is('strong, b') ? $(el).parent().next() : $(el).next();
    let attempts = 0;
    while (next.length && attempts < 5) {
      if (next.is('ul, ol')) {
        next.find('li').each((_, li) => {
          const text = $(li).text().trim();
          if (text) sections[matchedSection].push(text);
        });
        break;
      }
      if (next.is('h1, h2, h3, h4, h5, h6')) break;
      // Check if the element itself contains a list
      const nestedList = next.find('ul, ol');
      if (nestedList.length) {
        nestedList.find('li').each((_, li) => {
          const text = $(li).text().trim();
          if (text) sections[matchedSection].push(text);
        });
        break;
      }
      next = next.next();
      attempts++;
    }
  });

  // Extract skills from text
  const skillMatches = plainText.match(TECH_REGEX) || [];
  const skills = [...new Set(skillMatches.map(s => s.toLowerCase()))];

  // Parse salary
  let salary = null;
  for (const pattern of SALARY_PATTERNS) {
    const match = plainText.match(pattern);
    if (match) {
      const min = parseInt(match[1].replace(/,/g, ''), 10);
      const max = parseInt(match[2].replace(/,/g, ''), 10);
      let currency = 'USD';
      if (/AED/i.test(match[0])) currency = 'AED';
      else if (/EUR/i.test(match[0])) currency = 'EUR';
      else if (/GBP/i.test(match[0])) currency = 'GBP';
      salary = { min, max, currency };
      break;
    }
  }

  // Summary: first 200 chars of plain text
  const summary = plainText.substring(0, 200).replace(/\s+/g, ' ').trim();

  // Highlights: first 5 list items from the description
  const allListItems = [];
  $('li').each((_, li) => {
    const text = $(li).text().trim();
    if (text && text.length > 10 && text.length < 300) {
      allListItems.push(text);
    }
  });
  const highlights = allListItems.slice(0, 5);

  // Detect job type
  let job_type = null;
  if (/\bfull[- ]?time\b/i.test(plainText)) job_type = 'FULL_TIME';
  else if (/\bpart[- ]?time\b/i.test(plainText)) job_type = 'PART_TIME';
  else if (/\bcontract\b/i.test(plainText)) job_type = 'CONTRACT';
  else if (/\binternship\b|\bintern\b/i.test(plainText)) job_type = 'INTERNSHIP';
  else if (/\bfreelance\b/i.test(plainText)) job_type = 'FREELANCE';

  // Detect experience level from description
  let experience_level = null;
  if (/\b(?:senior|sr\.|lead|staff|principal)\b/i.test(plainText)) experience_level = 'SENIOR';
  else if (/\b(?:junior|jr\.|entry[- ]level|graduate|intern)\b/i.test(plainText)) experience_level = 'ENTRY';
  else if (/\b(?:director|vp|vice president|head of|chief)\b/i.test(plainText)) experience_level = 'EXECUTIVE';
  else if (/\b(?:mid[- ]?level|intermediate|[3-6]\+?\s*years)\b/i.test(plainText)) experience_level = 'MID';

  // Visa sponsorship
  const visa_sponsorship = /visa\s*(?:sponsor|support)/i.test(plainText);

  return {
    requirements: sections.requirements,
    responsibilities: sections.responsibilities,
    benefits: sections.benefits,
    skills,
    salary,
    summary,
    highlights,
    required_qualifications: sections.requirements,
    preferred_qualifications: sections.preferred,
    job_type,
    experience_level,
    visa_sponsorship,
  };
}

function parseExperienceLevelFromTitle(title) {
  if (!title) return null;
  if (/\b(?:senior|sr\.|lead|staff|principal)\b/i.test(title)) return 'SENIOR';
  if (/\b(?:junior|jr\.|entry[- ]level|graduate|intern)\b/i.test(title)) return 'ENTRY';
  if (/\b(?:director|vp|vice president|head of|chief)\b/i.test(title)) return 'EXECUTIVE';
  return null;
}

function stripHtml(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, ' ').trim();
}

module.exports = { parseDescription, parseExperienceLevelFromTitle, stripHtml };
