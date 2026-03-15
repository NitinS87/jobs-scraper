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
