const cheerio = require('cheerio');

// Canonical display names for tech skills (properly cased)
const SKILL_DISPLAY_NAMES = {
  'javascript': 'JavaScript', 'typescript': 'TypeScript', 'python': 'Python',
  'java': 'Java', 'golang': 'Golang', 'go': 'Go', 'ruby': 'Ruby', 'rust': 'Rust',
  'c++': 'C++', 'c#': 'C#', '.net': '.NET', 'php': 'PHP',
  'swift': 'Swift', 'kotlin': 'Kotlin', 'scala': 'Scala', 'elixir': 'Elixir', 'haskell': 'Haskell',
  'react': 'React', 'angular': 'Angular', 'vue': 'Vue', 'svelte': 'Svelte',
  'next.js': 'Next.js', 'nuxt': 'Nuxt', 'node.js': 'Node.js', 'express': 'Express',
  'django': 'Django', 'flask': 'Flask', 'fastapi': 'FastAPI', 'rails': 'Rails',
  'spring': 'Spring', 'laravel': 'Laravel',
  'aws': 'AWS', 'azure': 'Azure', 'gcp': 'GCP', 'docker': 'Docker',
  'kubernetes': 'Kubernetes', 'terraform': 'Terraform', 'ansible': 'Ansible',
  'postgresql': 'PostgreSQL', 'mysql': 'MySQL', 'mongodb': 'MongoDB',
  'redis': 'Redis', 'elasticsearch': 'Elasticsearch', 'dynamodb': 'DynamoDB', 'cassandra': 'Cassandra',
  'graphql': 'GraphQL', 'rest api': 'REST API', 'grpc': 'gRPC', 'kafka': 'Kafka', 'rabbitmq': 'RabbitMQ',
  'machine learning': 'Machine Learning', 'deep learning': 'Deep Learning',
  'nlp': 'NLP', 'computer vision': 'Computer Vision', 'pytorch': 'PyTorch', 'tensorflow': 'TensorFlow',
  'html': 'HTML', 'css': 'CSS', 'sass': 'Sass', 'tailwind': 'Tailwind', 'webpack': 'Webpack', 'vite': 'Vite',
  'git': 'Git', 'ci/cd': 'CI/CD', 'jenkins': 'Jenkins', 'github actions': 'GitHub Actions', 'circleci': 'CircleCI',
  'linux': 'Linux', 'unix': 'Unix', 'bash': 'Bash', 'sql': 'SQL', 'nosql': 'NoSQL',
  'figma': 'Figma', 'sketch': 'Sketch', 'adobe': 'Adobe', 'photoshop': 'Photoshop', 'illustrator': 'Illustrator',
  'agile': 'Agile', 'scrum': 'Scrum', 'jira': 'Jira', 'confluence': 'Confluence',
  'solidity': 'Solidity', 'web3': 'Web3', 'blockchain': 'Blockchain', 'ethereum': 'Ethereum',
};

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

  // Extract skills from text with proper casing
  const skillMatches = plainText.match(TECH_REGEX) || [];
  const seen = new Set();
  const skills = [];
  for (const match of skillMatches) {
    const key = match.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      skills.push(SKILL_DISPLAY_NAMES[key] || match);
    }
  }

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

// Map location strings to ISO 3166-1 alpha-2 country codes
const COUNTRY_MAP = {
  'united states': 'US', 'usa': 'US', 'u.s.a.': 'US', 'u.s.': 'US',
  'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'canada': 'CA', 'australia': 'AU', 'germany': 'DE', 'deutschland': 'DE',
  'france': 'FR', 'netherlands': 'NL', 'holland': 'NL', 'spain': 'ES',
  'italy': 'IT', 'portugal': 'PT', 'switzerland': 'CH', 'austria': 'AT',
  'belgium': 'BE', 'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK',
  'finland': 'FI', 'ireland': 'IE', 'poland': 'PL', 'czech republic': 'CZ',
  'czechia': 'CZ', 'romania': 'RO', 'hungary': 'HU', 'greece': 'GR',
  'croatia': 'HR', 'bulgaria': 'BG', 'slovakia': 'SK', 'slovenia': 'SI',
  'estonia': 'EE', 'latvia': 'LV', 'lithuania': 'LT', 'luxembourg': 'LU',
  'malta': 'MT', 'cyprus': 'CY', 'iceland': 'IS',
  'japan': 'JP', 'india': 'IN', 'china': 'CN', 'south korea': 'KR', 'korea': 'KR',
  'singapore': 'SG', 'hong kong': 'HK', 'taiwan': 'TW', 'thailand': 'TH',
  'vietnam': 'VN', 'philippines': 'PH', 'indonesia': 'ID', 'malaysia': 'MY',
  'pakistan': 'PK', 'bangladesh': 'BD', 'sri lanka': 'LK',
  'brazil': 'BR', 'mexico': 'MX', 'argentina': 'AR', 'colombia': 'CO',
  'chile': 'CL', 'peru': 'PE', 'uruguay': 'UY', 'costa rica': 'CR',
  'israel': 'IL', 'turkey': 'TR', 'south africa': 'ZA', 'nigeria': 'NG',
  'kenya': 'KE', 'egypt': 'EG', 'morocco': 'MA', 'ghana': 'GH',
  'united arab emirates': 'AE', 'uae': 'AE', 'dubai': 'AE',
  'saudi arabia': 'SA', 'qatar': 'QA', 'bahrain': 'BH', 'kuwait': 'KW', 'oman': 'OM',
  'new zealand': 'NZ', 'russia': 'RU', 'ukraine': 'UA',
  'cayman islands': 'KY',
};

// US state abbreviations for detecting US locations like "Atlanta, GA"
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

function parseCountryCode(locationString) {
  if (!locationString) return null;

  const loc = locationString.trim();

  // "Remote" alone → null
  if (/^remote$/i.test(loc) || /^anywhere/i.test(loc) || /^worldwide$/i.test(loc)) return null;

  // Already an ISO code (2 uppercase letters)
  if (/^[A-Z]{2}$/.test(loc)) return loc;

  // Check for "Remote (US)" or "Remote - Germany" patterns
  const parenMatch = loc.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const inner = parenMatch[1].trim();
    if (/^[A-Z]{2}$/.test(inner)) return inner;
    const mapped = COUNTRY_MAP[inner.toLowerCase()];
    if (mapped) return mapped;
  }

  // Split by comma and check each part (right to left — country usually last)
  const parts = loc.split(/[,\-–—]/).map(p => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].toLowerCase().replace(/[()]/g, '').trim();
    if (COUNTRY_MAP[part]) return COUNTRY_MAP[part];

    // Check 2-letter uppercase (ISO code in text like "City, US")
    const upper = parts[i].trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(upper) && COUNTRY_MAP[upper.toLowerCase()]) {
      return COUNTRY_MAP[upper.toLowerCase()];
    }
  }

  // US state abbreviation detection: "City, GA" or "City, GA, US"
  for (const part of parts) {
    const trimmed = part.trim().toUpperCase();
    if (US_STATES.has(trimmed)) return 'US';
  }

  // Full-text search in the string
  for (const [name, code] of Object.entries(COUNTRY_MAP)) {
    if (loc.toLowerCase().includes(name)) return code;
  }

  return null;
}

// Parse free-form salary text into structured { min, max, currency }
function parseSalaryText(text) {
  if (!text) return null;

  const str = text.replace(/,/g, '').trim();

  // JPY patterns: "7M - 15M JPY", "¥7,000,000", "¥7M-15M", "7000000 - 15000000 JPY"
  const jpyMatch = str.match(/[¥￥]\s*([\d.]+)\s*([MmKk])?\s*(?:[-–—to]+\s*[¥￥]?\s*([\d.]+)\s*([MmKk])?)?/);
  if (jpyMatch) {
    let min = parseFloat(jpyMatch[1]);
    const minMult = jpyMatch[2];
    let max = jpyMatch[3] ? parseFloat(jpyMatch[3]) : min;
    const maxMult = jpyMatch[4] || minMult;
    if (/[Mm]/.test(minMult)) min *= 1000000;
    else if (/[Kk]/.test(minMult)) min *= 1000;
    if (/[Mm]/.test(maxMult)) max *= 1000000;
    else if (/[Kk]/.test(maxMult)) max *= 1000;
    return { min: Math.round(min), max: Math.round(max), currency: 'JPY' };
  }

  // "7M - 15M JPY" without yen sign
  const jpyTextMatch = str.match(/([\d.]+)\s*([MmKk])?\s*[-–—to]+\s*([\d.]+)\s*([MmKk])?\s*JPY/i);
  if (jpyTextMatch) {
    let min = parseFloat(jpyTextMatch[1]);
    const minMult = jpyTextMatch[2];
    let max = parseFloat(jpyTextMatch[3]);
    const maxMult = jpyTextMatch[4] || minMult;
    if (/[Mm]/.test(minMult)) min *= 1000000;
    else if (/[Kk]/.test(minMult)) min *= 1000;
    if (/[Mm]/.test(maxMult)) max *= 1000000;
    else if (/[Kk]/.test(maxMult)) max *= 1000;
    return { min: Math.round(min), max: Math.round(max), currency: 'JPY' };
  }

  // EUR patterns: "€60,000-€80,000", "60K-80K EUR", "EUR 60000-80000"
  const eurMatch = str.match(/(?:€|EUR)\s*([\d.]+)\s*([Kk])?\s*[-–—to]+\s*(?:€|EUR)?\s*([\d.]+)\s*([Kk])?/i)
    || str.match(/([\d.]+)\s*([Kk])?\s*[-–—to]+\s*([\d.]+)\s*([Kk])?\s*EUR/i);
  if (eurMatch) {
    let min = parseFloat(eurMatch[1]);
    let max = parseFloat(eurMatch[3]);
    if (/[Kk]/.test(eurMatch[2])) min *= 1000;
    if (/[Kk]/.test(eurMatch[4] || eurMatch[2])) max *= 1000;
    return { min: Math.round(min), max: Math.round(max), currency: 'EUR' };
  }

  // AED patterns: "AED 8,000 - 12,000", "8000-12000 AED"
  const aedMatch = str.match(/AED\s*([\d.]+)\s*([Kk])?\s*[-–—to]+\s*([\d.]+)\s*([Kk])?/i)
    || str.match(/([\d.]+)\s*([Kk])?\s*[-–—to]+\s*([\d.]+)\s*([Kk])?\s*AED/i);
  if (aedMatch) {
    let min = parseFloat(aedMatch[1]);
    let max = parseFloat(aedMatch[3]);
    if (/[Kk]/.test(aedMatch[2])) min *= 1000;
    if (/[Kk]/.test(aedMatch[4] || aedMatch[2])) max *= 1000;
    return { min: Math.round(min), max: Math.round(max), currency: 'AED' };
  }

  // GBP patterns: "£60,000-£80,000", "60K-80K GBP"
  const gbpMatch = str.match(/(?:£|GBP)\s*([\d.]+)\s*([Kk])?\s*[-–—to]+\s*(?:£|GBP)?\s*([\d.]+)\s*([Kk])?/i)
    || str.match(/([\d.]+)\s*([Kk])?\s*[-–—to]+\s*([\d.]+)\s*([Kk])?\s*GBP/i);
  if (gbpMatch) {
    let min = parseFloat(gbpMatch[1]);
    let max = parseFloat(gbpMatch[3]);
    if (/[Kk]/.test(gbpMatch[2])) min *= 1000;
    if (/[Kk]/.test(gbpMatch[4] || gbpMatch[2])) max *= 1000;
    return { min: Math.round(min), max: Math.round(max), currency: 'GBP' };
  }

  // USD patterns: "$60,000-$80,000", "60K-80K USD"
  const usdMatch = str.match(/(?:\$|USD)\s*([\d.]+)\s*([Kk])?\s*[-–—to]+\s*(?:\$|USD)?\s*([\d.]+)\s*([Kk])?/i)
    || str.match(/([\d.]+)\s*([Kk])?\s*[-–—to]+\s*([\d.]+)\s*([Kk])?\s*USD/i);
  if (usdMatch) {
    let min = parseFloat(usdMatch[1]);
    let max = parseFloat(usdMatch[3]);
    if (/[Kk]/.test(usdMatch[2])) min *= 1000;
    if (/[Kk]/.test(usdMatch[4] || usdMatch[2])) max *= 1000;
    return { min: Math.round(min), max: Math.round(max), currency: 'USD' };
  }

  return null;
}

module.exports = { parseDescription, parseExperienceLevelFromTitle, stripHtml, parseCountryCode, parseSalaryText };
