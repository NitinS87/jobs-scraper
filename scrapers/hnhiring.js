const axios = require('axios');
const cheerio = require('cheerio');
const {
  parseDescription,
  parseExperienceLevelFromTitle,
  stripHtml,
  parseCountryCode,
  parseSalaryText,
} = require('../lib/descriptionParser');

function extractHrefs(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const hrefs = [];
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href');
    if (h && /^https?:\/\//i.test(h)) hrefs.push(h);
  });
  return hrefs;
}

const ALGOLIA_SEARCH = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=20';
const ALGOLIA_ITEM = (id) => `https://hn.algolia.com/api/v1/items/${id}`;
const HN_ITEM_URL = (id) => `https://news.ycombinator.com/item?id=${id}`;
const RECENT_THREADS = 3;

const TITLE_KEYWORDS = /\b(Engineer|Developer|Designer|Manager|Scientist|Lead|PM|Architect|Founder|Researcher|SRE|DevOps|Analyst|Director|Programmer|Consultant|Specialist|Administrator|QA|Tester|Architect|CTO|CEO|VP|Head|Principal|Staff|Senior|Junior)\b/i;
const REMOTE_KEYWORDS = /\b(REMOTE|Remote|Onsite|On-site|Hybrid|WFH)\b/;
const REMOTE_DETECT = /\bremote\b/i;
const ONSITE_DETECT = /\bon[- ]?site\b/i;
const HYBRID_DETECT = /\bhybrid\b/i;
const REMOTE_SCOPE = /Remote\s*\(([^)]+)\)/i;
const SALARY_REGEX = /(?:\$|USD\s*|€|EUR\s*|£|GBP\s*|₹|INR\s*)?\s*([\d][\d,.]*)\s*([Kk])?\s*[-–—]\s*\$?\s*([\d][\d,.]*)\s*([Kk])?\s*(USD|EUR|GBP|CAD|INR|AUD)?/;
const EMAIL_REGEX = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const URL_REGEX = /(https?:\/\/[\w.\-]+(?:\/[\w.\-\/?#=&%@~+:]*)?)/i;
const YC_BATCH_REGEX = /\((YC\s+[WS]\d{2,4}|[WS]\d{2,4})\)/i;
const EXPERIENCE_LEVELS = {
  senior: /\b(senior|sr\.?|lead|staff|principal)\b/i,
  entry: /\b(junior|jr\.?|entry[- ]level|graduate|new grad|intern)\b/i,
  executive: /\b(director|vp|vice president|head of|chief|cto|ceo)\b/i,
  mid: /\b(mid[- ]?level|intermediate|[3-6]\+?\s*years)\b/i,
};

const JOB_TYPE_PATTERNS = {
  FULL_TIME: /\bfull[- ]?time\b/i,
  PART_TIME: /\bpart[- ]?time\b/i,
  CONTRACT: /\b(contract|contractor|contracting)\b/i,
  INTERNSHIP: /\b(intern(ship)?)\b/i,
  FREELANCE: /\bfreelance\b/i,
};

function parseSalary(text) {
  const match = text.match(SALARY_REGEX);
  if (!match) return null;
  const [, minStr, minK, maxStr, maxK, currencyHint] = match;
  let min = parseFloat(minStr.replace(/,/g, ''));
  let max = parseFloat(maxStr.replace(/,/g, ''));
  if (Number.isNaN(min) || Number.isNaN(max)) return null;
  if (minK) min *= 1000;
  if (maxK) max *= 1000;
  // If only one side has K, infer the other (e.g. "150-200k" or "150k-200")
  if (!minK && maxK && min < 1000) min *= 1000;
  if (minK && !maxK && max < 1000) max *= 1000;
  // Reject low/implausible annual salaries (< $10k) and inverted ranges
  if (min < 10000 || max < 10000) return null;
  if (max < min) return null;
  // Reject outlandishly high values (likely a non-salary number range)
  if (max > 10_000_000) return null;

  let currency = (currencyHint || '').toUpperCase() || null;
  if (!currency) {
    if (/€|EUR/i.test(match[0])) currency = 'EUR';
    else if (/£|GBP/i.test(match[0])) currency = 'GBP';
    else if (/₹|INR/i.test(match[0])) currency = 'INR';
    else if (/\$|USD/i.test(match[0])) currency = 'USD';
    else currency = 'USD';
  }
  return { min, max, currency };
}

function detectJobType(text) {
  for (const [type, pattern] of Object.entries(JOB_TYPE_PATTERNS)) {
    if (pattern.test(text)) return type;
  }
  return null;
}

function detectExperienceLevel(title, text) {
  const fromTitle = parseExperienceLevelFromTitle(title);
  if (fromTitle) return fromTitle;
  if (EXPERIENCE_LEVELS.senior.test(text)) return 'SENIOR';
  if (EXPERIENCE_LEVELS.entry.test(text)) return 'ENTRY';
  if (EXPERIENCE_LEVELS.executive.test(text)) return 'EXECUTIVE';
  if (EXPERIENCE_LEVELS.mid.test(text)) return 'MID';
  return null;
}

function parseComment(comment, threadDate) {
  const rawText = stripHtml(comment.text || '');
  if (!rawText || rawText.length < 30) return null;

  const segments = rawText.split(/\s*\|\s*|\n+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  // Company: first segment, strip YC batch
  const firstSegment = segments[0];
  const ycMatch = firstSegment.match(YC_BATCH_REGEX);
  const ycBatch = ycMatch ? ycMatch[1].toUpperCase().replace(/^YC\s+/, '') : null;
  let companyName = firstSegment.replace(YC_BATCH_REGEX, '').trim();
  // Strip leading/trailing punctuation/dashes/decorative bars
  companyName = companyName.replace(/^[\s\-_=*#~`]+/, '').replace(/[\s\-_=*#~`.,;:]+$/, '');
  // Drop trailing URL/email if jammed onto the company name
  companyName = companyName.replace(/\s*(?:https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+)\s*$/i, '').trim();
  if (!companyName || companyName.length > 80) return null;
  // Reject if the "name" is just decoration (no letters) or contains a URL/email
  if (!/[a-z]/i.test(companyName)) return null;
  if (/https?:\/\//i.test(companyName) || /@.+\./i.test(companyName)) return null;
  // Reject if it looks like a job-seeker post header rather than a company
  if (/^seeking\s/i.test(companyName) || /^who\s+wants/i.test(companyName)) return null;

  // Title: first segment containing a job-title keyword (after company)
  let title = null;
  for (let i = 1; i < segments.length; i++) {
    if (TITLE_KEYWORDS.test(segments[i]) && segments[i].length < 120) {
      title = segments[i];
      break;
    }
  }
  // Fallback: search whole text for a recognizable role pattern
  if (!title) {
    const roleMatch = rawText.match(/\b((?:Senior|Junior|Staff|Principal|Lead)?\s*(?:Software|Backend|Frontend|Full[- ]?Stack|Mobile|iOS|Android|Data|ML|Machine Learning|DevOps|Site Reliability|Security|Platform|Infrastructure|Product|Engineering)?\s*(?:Engineer|Developer|Designer|Manager|Scientist|Architect|Researcher))\b/i);
    if (roleMatch) title = roleMatch[1].trim();
  }

  // Location + remote
  let location = null;
  let isRemote = false;
  const remoteScope = rawText.match(REMOTE_SCOPE);
  if (remoteScope) {
    location = `Remote (${remoteScope[1].trim()})`;
    isRemote = true;
  }
  if (!location) {
    for (const seg of segments) {
      if (REMOTE_KEYWORDS.test(seg) && seg.length < 80) {
        location = seg;
        if (REMOTE_DETECT.test(seg)) isRemote = true;
        break;
      }
    }
  }
  if (!isRemote && REMOTE_DETECT.test(rawText)) isRemote = true;
  let workMode = null;
  if (HYBRID_DETECT.test(rawText)) workMode = 'HYBRID';
  else if (isRemote) workMode = 'REMOTE';
  else if (ONSITE_DETECT.test(rawText)) workMode = 'ONSITE';

  // Salary
  let salary = parseSalary(rawText);
  if (!salary) {
    const fallback = parseSalaryText(rawText);
    if (fallback && fallback.min >= 10000 && fallback.max >= 10000 && fallback.max <= 10_000_000 && fallback.max >= fallback.min) {
      salary = fallback;
    }
  }

  // Contact: prefer href from HTML (preserves URL boundary), fall back to regex on plain text
  const hrefs = extractHrefs(comment.text || '');
  const firstHref = hrefs.find((h) => !/news\.ycombinator\.com/i.test(h)) || null;
  const urlMatch = firstHref ? [firstHref, firstHref] : rawText.match(URL_REGEX);
  const emailMatch = rawText.match(EMAIL_REGEX);

  // Reject if no title AND no salary AND no apply url/email
  if (!title && !salary && !urlMatch && !emailMatch) return null;

  // Skills via descriptionParser (wrap in <p> so cheerio extracts text)
  const wrappedHtml = `<p>${(comment.text || '').replace(/<\/?p>/gi, '')}</p>`;
  const parsed = parseDescription(wrappedHtml);

  const country = parseCountryCode(location || rawText);
  const jobType = detectJobType(rawText) || 'FULL_TIME';
  const experienceLevel = detectExperienceLevel(title || '', rawText);

  const sourceUrl = urlMatch ? urlMatch[1] : HN_ITEM_URL(comment.id);
  const postedAt = comment.created_at
    ? new Date(comment.created_at).toISOString()
    : (threadDate || new Date().toISOString());

  const description = comment.text || `<p>${rawText}</p>`;
  const summary = rawText.slice(0, 200);

  const categories = [];
  if (ycBatch) categories.push(`YC ${ycBatch}`);

  return {
    title: title || `${companyName} - Hiring`,
    source_url: sourceUrl,
    description,
    posted_at: postedAt,
    external_job_id: `hn-${comment.id}`,
    external_source: 'HNHiring',
    source_type: 'API',
    source_base_url: 'https://news.ycombinator.com',
    is_remote: isRemote,
    location: location || null,
    country_code: country,
    job_type: jobType,
    experience_level: experienceLevel,
    salary_min: salary ? salary.min : null,
    salary_max: salary ? salary.max : null,
    salary_currency: salary ? salary.currency : null,
    skills: parsed.skills.length > 0 ? parsed.skills : [],
    requirements: parsed.requirements,
    responsibilities: parsed.responsibilities,
    benefits: parsed.benefits,
    summary,
    highlights: parsed.highlights,
    required_qualifications: parsed.required_qualifications,
    preferred_qualifications: parsed.preferred_qualifications,
    visa_sponsorship: parsed.visa_sponsorship || /visa\s*(?:sponsor|support)/i.test(rawText),
    categories,
    work_mode: workMode,
    contact_email: emailMatch ? emailMatch[0] : null,
    company: {
      name: companyName,
      website: urlMatch ? urlMatch[1] : null,
      country_code: country,
    },
  };
}

async function fetchThreadComments(storyId) {
  const { data } = await axios.get(ALGOLIA_ITEM(storyId), { timeout: 30000 });
  if (!data || !Array.isArray(data.children)) return { comments: [], threadDate: null };
  const threadDate = data.created_at ? new Date(data.created_at).toISOString() : null;
  return { comments: data.children, threadDate };
}

async function scrapeHNHiring() {
  console.log('Fetching HN "Who is hiring?" threads via Algolia API...');
  let stories;
  try {
    const { data } = await axios.get(ALGOLIA_SEARCH, { timeout: 30000 });
    stories = (data.hits || [])
      .filter((h) => /^Ask HN:\s*Who is hiring\?/i.test(h.title || ''))
      .slice(0, RECENT_THREADS);
  } catch (err) {
    console.error('HN: failed to fetch story list:', err.message);
    return [];
  }

  if (stories.length === 0) {
    console.warn('HN: no "Who is hiring?" stories found');
    return [];
  }

  console.log(`HN: found ${stories.length} recent thread(s) (${stories.map((s) => s.title).join(' / ')})`);

  const allJobs = [];
  let totalComments = 0;
  let skipped = 0;

  for (const story of stories) {
    let result;
    try {
      result = await fetchThreadComments(story.objectID);
    } catch (err) {
      console.warn(`HN: failed to fetch thread ${story.objectID}: ${err.message}`);
      continue;
    }
    const { comments, threadDate } = result;
    totalComments += comments.length;
    for (const comment of comments) {
      if (!comment || !comment.text) continue;
      const job = parseComment(comment, threadDate);
      if (job) {
        allJobs.push(job);
      } else {
        skipped++;
      }
    }
    console.log(`HN: thread ${story.objectID} → parsed ${comments.length} comments (skipped ${skipped} so far)`);
  }

  console.log(`HN: extracted ${allJobs.length} jobs from ${totalComments} comments (${skipped} skipped)`);
  return allJobs;
}

module.exports = scrapeHNHiring;
