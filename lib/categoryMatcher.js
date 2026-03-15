const supabase = require('./supabaseClient');

// Hardcoded keyword-to-category-name mappings
const KEYWORD_MAP = [
  { pattern: /\bbackend\b|server[- ]side/i, category: 'Backend Engineer' },
  { pattern: /\bfrontend\b|front[- ]end\b|\bui developer\b/i, category: 'Frontend Software Engineer' },
  { pattern: /\bfull[- ]?stack\b/i, category: 'Full Stack Engineer' },
  { pattern: /\breact\b/i, category: 'React Developer' },
  { pattern: /\bandroid\b/i, category: 'Android Developer' },
  { pattern: /\bios\b|\bswift\b/i, category: 'iOS/Swift Developer' },
  { pattern: /\bflutter\b/i, category: 'Flutter Developer' },
  { pattern: /\bpython\b/i, category: 'Python Engineer' },
  { pattern: /\bjava\b(?!script)/i, category: 'Java Engineer' },
  { pattern: /\bgolang\b|\bgo developer\b|\bgo engineer\b/i, category: 'Golang Engineer' },
  { pattern: /\bdevops\b|\bci\/cd\b|\binfrastructure\b/i, category: 'DevOps' },
  { pattern: /\bsre\b|\breliability\b/i, category: 'Site Reliability Engineer (SRE)' },
  { pattern: /\bdata\s*scien/i, category: 'Data Scientist' },
  { pattern: /\bdata\s*eng/i, category: 'Data Engineer' },
  { pattern: /\bdata\s*analyst/i, category: 'Data Analyst' },
  { pattern: /\bmachine\s*learn|\bml\s/i, category: 'Machine Learning Engineer' },
  { pattern: /\bai engineer\b|\bartificial\s*intel/i, category: 'AI Engineer' },
  { pattern: /\bllm\b|\blarge\s*language/i, category: 'LLM Engineer' },
  { pattern: /\bblockchain\b|\bweb3\b|\bcrypto\b|\bsolidity\b/i, category: 'Blockchain Engineer' },
  { pattern: /\bqa\b|\bquality\s*assur|\btest/i, category: 'Software Testing/Quality Assurance Engineer' },
  { pattern: /\bproduct\s*manag/i, category: 'Product Manager' },
  { pattern: /\bux\s*design/i, category: 'UX Designer' },
  { pattern: /\bui\s*design/i, category: 'UI Designer' },
  { pattern: /\bgraphic\s*design/i, category: 'Graphic Designer' },
  { pattern: /\bproject\s*manag|\bprogram\s*manag/i, category: 'Project/Program Manager (Project Management)' },
  { pattern: /\bengineering\s*manag/i, category: 'Engineering Manager' },
  { pattern: /\bsecurity\b|\bcyber/i, category: 'Cyber Security Engineer' },
  { pattern: /\bcloud\b/i, category: 'Cloud Security Engineer' },
  { pattern: /\bdatabase\b|\bdba\b/i, category: 'Database Administrator' },
  { pattern: /\bsystem\s*admin/i, category: 'System Administrator' },
  { pattern: /\bsales\s*eng/i, category: 'Sales Engineer (Technical Sales)' },
  { pattern: /\bcustomer\s*succ/i, category: 'Customer Success (Customer Success)' },
  { pattern: /\bcustomer\s*support/i, category: 'Customer Support (Customer Support)' },
  { pattern: /\bmarketing\b/i, category: 'Content Marketing/Strategy' },
  { pattern: /\bcopywriter\b|\bcontent\s*writ/i, category: 'Copywriter' },
  { pattern: /\bseo\b/i, category: 'SEO' },
  { pattern: /\b\.net\b/i, category: '.Net Engineer' },
  { pattern: /\bsalesforce\b/i, category: 'Salesforce Developer' },
  { pattern: /\btechnical\s*writ/i, category: 'Technical Writing' },
  { pattern: /\bdev\s*rel|\bdeveloper\s*relat|\bdeveloper\s*advoc/i, category: 'Developer Relations' },
  { pattern: /\bscrum\s*master/i, category: 'Scrum Master' },
  { pattern: /\bsoftware\s*arch/i, category: 'Software Architect' },
  { pattern: /\bunity\b/i, category: 'Unity Developer' },
  { pattern: /\bunreal\b/i, category: 'Unreal Engine Developer' },
  { pattern: /\bgame\s*dev/i, category: 'Game Developer' },
  { pattern: /\bar\/vr\b|\baugmented\b|\bvirtual\s*reality/i, category: 'AR/VR Developer' },
  { pattern: /\brobotic/i, category: 'Robotics Engineer' },
  { pattern: /\bembedded\b/i, category: 'Embedded Software Engineer' },
  { pattern: /\bnetwork\s*eng/i, category: 'Network Engineer (System Reliability & Security)' },
  { pattern: /\bsolutions?\s*arch/i, category: 'Solutions Architect' },
  // Broader patterns for better coverage
  { pattern: /\bsoftware\s*eng|\bswe\b/i, category: 'Backend Engineer' },
  { pattern: /\bproduct\s*analyst/i, category: 'Product Analyst' },
  { pattern: /\btechnical\s*product\s*manag/i, category: 'Technical Product Manager' },
  { pattern: /\bdesign\s*eng/i, category: 'Mechanical Engineer' },
  { pattern: /\bmanufactur/i, category: 'Manufacturing Engineer' },
  { pattern: /\bsupply\s*chain/i, category: 'Supply Chain Manager' },
  { pattern: /\boperations\s*manag/i, category: 'Operations Manager/Director' },
  { pattern: /\bfinancial\s*analyst/i, category: 'Financial Analyst' },
  { pattern: /\btax\b/i, category: 'Tax Specialist' },
  { pattern: /\baccountant|\baccounting/i, category: 'Accountant' },
  { pattern: /\brecruit/i, category: 'Recruiter/Sourcer' },
  { pattern: /\bhr\b|\bhuman\s*resource/i, category: 'Human Resource Specialist' },
  { pattern: /\bcustomer\s*service/i, category: 'Customer Service Representative' },
  { pattern: /\baccount\s*exec/i, category: 'Account Executive, SMB' },
  { pattern: /\bsales\s*(?:rep|dev|manager|director)/i, category: 'Sales Development Representative' },
  { pattern: /\bpayroll/i, category: 'Payroll Specialist' },
  { pattern: /\bcompliance/i, category: 'Compliance Specialist' },
  { pattern: /\brisk\b/i, category: 'Risk Analyst (Compliance & Risk Management)' },
  { pattern: /\bpower\s*(?:system|engineer)/i, category: 'Power Systems Engineer' },
  { pattern: /\baerospace/i, category: 'Aerospace Engineer' },
  { pattern: /\belectrical\s*eng/i, category: 'Electrical Engineer' },
  { pattern: /\bmechanical\s*eng/i, category: 'Mechanical Engineer' },
  { pattern: /\bfpga\b|\basic\b/i, category: 'FPGA Engineer' },
  { pattern: /\brtl\b|\bic\s*design/i, category: 'IC Design Engineer' },
  { pattern: /\bprocess\s*eng/i, category: 'Process Engineer' },
  { pattern: /\bsafety\s*eng/i, category: 'Safety Engineer' },
  { pattern: /\bfacilities/i, category: 'Facilities Manager' },
  { pattern: /\btechnical\s*support|\bsupport\s*eng/i, category: 'IT Support Specialist' },
  { pattern: /\bvideo\s*edit/i, category: 'Video Editor' },
  { pattern: /\bmotion\s*design/i, category: 'Motion Designer' },
  { pattern: /\bbrand\s*manag/i, category: 'Brand Manager' },
  { pattern: /\bcommunity\s*manag/i, category: 'Community Manager' },
  { pattern: /\bpublic\s*relat/i, category: 'Public Relations' },
  { pattern: /\bevent\s*market/i, category: 'Event Marketing Specialist' },
  { pattern: /\bperformance\s*market/i, category: 'Performance Marketing' },
  { pattern: /\bgrowth\s*market/i, category: 'Growth Marketing (Growth Marketing)' },
  { pattern: /\bproduct\s*market/i, category: 'Product Marketing (Product Marketing)' },
  { pattern: /\bemail\s*market/i, category: 'Email Marketing' },
  { pattern: /\bdata\s*entry/i, category: 'Data Entry Clerk' },
  { pattern: /\badmin\s*assist|\bexecutive\s*assist/i, category: 'Administrative Assistant' },
  { pattern: /\boffice\s*manag/i, category: 'Office Manager' },
  { pattern: /\btrader\b|\btrading\b/i, category: 'Securities Trader' },
  { pattern: /\binvestment/i, category: 'Investment Analyst/Associate' },
];

let categoryCache = null; // { nameToId: Map, categories: [] }

async function loadCategories() {
  if (categoryCache) return categoryCache;

  const { data, error } = await supabase
    .from('job_categories')
    .select('id, name, parent_id');

  if (error) throw new Error(`Failed to load categories: ${error.message}`);

  // Build a set of IDs that are parents (so we can identify leaf nodes)
  const parentIds = new Set(data.filter(c => c.parent_id).map(c => c.parent_id));

  // Leaf categories are those that are NOT parents of anyone
  const leaves = data.filter(c => !parentIds.has(c.id));

  const nameToId = new Map();
  for (const cat of leaves) {
    nameToId.set(cat.name.toLowerCase(), cat.id);
  }

  categoryCache = { nameToId, categories: leaves };
  return categoryCache;
}

async function matchCategories(jobTitle, sourceCategories = []) {
  const { nameToId } = await loadCategories();
  const matched = new Set();

  const titleLower = (jobTitle || '').toLowerCase();

  // 1. Exact title match against leaf category names
  if (nameToId.has(titleLower)) {
    matched.add(nameToId.get(titleLower));
  }

  // 2. Keyword match against job title
  for (const { pattern, category } of KEYWORD_MAP) {
    if (pattern.test(jobTitle || '')) {
      const catId = nameToId.get(category.toLowerCase());
      if (catId) matched.add(catId);
    }
  }

  // 3. Source category match (for Jobicy, WWR)
  for (const srcCat of sourceCategories) {
    const srcLower = (srcCat || '').toLowerCase();
    // Try exact match first
    if (nameToId.has(srcLower)) {
      matched.add(nameToId.get(srcLower));
      continue;
    }
    // Try keyword match
    for (const { pattern, category } of KEYWORD_MAP) {
      if (pattern.test(srcCat || '')) {
        const catId = nameToId.get(category.toLowerCase());
        if (catId) matched.add(catId);
      }
    }
  }

  return [...matched];
}

module.exports = { matchCategories, loadCategories };
