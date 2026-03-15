const axios = require("axios");
const xml2js = require("xml2js");

const FEED_URL =
  "https://www.avjobs.com/special/RSS/rss_public_mgt_eng.asp";

function parseLocationFromDesc(desc) {
  // Pattern 1: "City, State Country - " at start (may have leading comma for some entries)
  const match = desc.match(/^\s*\r?\n?\s*,?\s*(.+?(?:United States|United Kingdom|Canada|Australia|Estonia|Cayman Islands|Germany|South Korea|Poland|France|Japan|India|[A-Z]{2}\s))\s*-/);
  if (match) {
    return match[1].trim().replace(/^,\s*/, '');
  }
  // Pattern 2: "City, ST" at very start
  const match2 = desc.match(/^\s*\r?\n?\s*,?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+)*)\s*-/);
  if (match2) {
    return match2[1].trim().replace(/^,\s*/, '');
  }
  return null;
}

function parseCompanyFromDesc(desc) {
  // Pattern 1: "At Boeing, we..." or "At Company Name, ..."
  const atMatch = desc.match(/\bAt\s+([A-Z][A-Za-z\s&.'-]+?),\s+we\b/);
  if (atMatch) return atMatch[1].trim();

  // Pattern 2: "Tactical Air Support Inc." — company name with Inc/LLC/Corp
  const incMatch = desc.match(/\b([A-Z][A-Za-z\s&.'-]*?\s+(?:Inc\.?|LLC|Corp\.?|Ltd\.?|Co\.?))\b/);
  if (incMatch) return incMatch[1].trim();

  // Pattern 3: "Join our fantastic Menzies Aviation team" or "Menzies Aviation (MA)"
  const joinMatch = desc.match(/(?:join|of)\s+(?:our\s+)?(?:fantastic\s+)?([A-Z][A-Za-z\s&.'-]+?)(?:\s+team|\s*\()/i);
  if (joinMatch) return joinMatch[1].trim();

  // Pattern 4: "People. Passion. Pride" + "global aviation" → Menzies Aviation
  if (/People\.\s*Passion\.\s*Pride/i.test(desc) || /Menzies\s*Aviation/i.test(desc)) {
    return "Menzies Aviation";
  }

  // Pattern 5: company name right after location dash, e.g. "- The Certifying Technician..."
  // Check if there's a company name pattern elsewhere
  const reportMatch = desc.match(/report to the\s+([A-Z][A-Za-z\s]+?)(?:\s+and\b|\s+at\b)/);
  if (reportMatch) {
    // Not a company, it's a role. Skip.
  }

  return null;
}

async function scrapeAVJobs() {
  const response = await axios.get(FEED_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  const items = parsed.rss.channel.item;

  const jobs = (Array.isArray(items) ? items : [items]).map((item) => {
    const urlPath = (item.link || "").split("/").filter(Boolean).pop() || item.link;
    const desc = item.description || "";

    const location = parseLocationFromDesc(desc);
    const companyName = parseCompanyFromDesc(desc);

    return {
      title: item.title,
      source_url: item.link,
      description: desc,
      posted_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      external_job_id: urlPath,
      external_source: "AVJobs",
      source_type: "RSS",
      source_base_url: "https://www.avjobs.com",
      is_remote: false,
      location: location,
      categories: [],
      company: companyName ? {
        name: companyName,
        industry: "Aviation",
      } : null,
    };
  });

  console.log(`Scraped ${jobs.length} jobs from AVJobs`);
  return jobs;
}

module.exports = scrapeAVJobs;
