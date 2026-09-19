/**
 * Pure data for lib/categoryScorer.js: title normalisation, curated rules and
 * the reject list. No logic, no I/O — this is the file that gets edited as
 * coverage gaps surface from `node scripts/recategorise.js --dry-run`.
 *
 * Every `category` here must be an EXACT leaf name from
 * lib/taxonomy.generated.json. test/categoryScorer.test.js asserts that, because
 * the old KEYWORD_MAP resolved names at runtime and silently dropped any that
 * did not match — a renamed category degraded coverage with no signal at all.
 */

// Score tiers. THRESHOLD in categoryScorer.js is 4.0, so WEAK alone never wins.
const STRONG = 8;   // unambiguous role noun ("toxicologist", "paralegal")
const NORMAL = 6;   // clear role match ("business development manager")
const NEAREST = 5;  // documented taxonomy gap — nearest available leaf
const DEFAULT = 4;  // generic-software floor; clears threshold only alone
const WEAK = 3;     // suggestive, needs corroboration

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// (m/f/d), (d/f/m), (w/m/d), (f/m/x), (m/v/d), (m/w/d) and friends. The German
// and Nordic boards put one of these on nearly every title.
const GENDER_TAG = /\(\s*[mwfdxavgn](?:\s*[/|·,]\s*[mwfdxavgn])+\s*\)/gi;
const GENDER_WORD = /\(?\s*\b(?:all\s+genders?|any\s+gender|divers|gn|h\/f|m\/w\/d)\b\s*\)?/gi;

// "80-100%", "(60 %)", "Vollzeit", contract shapes — noise on the EU boards.
const EMPLOYMENT_NOISE = new RegExp(
  '\\b\\d{1,3}\\s*[–-]\\s*\\d{1,3}\\s*%|\\b\\d{1,3}\\s*%'
  + '|\\b(?:full|part)[\\s-]?time\\b|\\bpermanent\\b|\\btemporary\\b|\\bfixed[\\s-]term\\b'
  + '|\\bcontract\\b|\\bfreelance\\b|\\bremote\\b|\\bhybrid\\b|\\bon[\\s-]?site\\b'
  + '|\\bmaternity\\s+(?:cover|leave)\\b|\\bin[\\s-]person\\b|\\bvollzeit\\b|\\bteilzeit\\b',
  'gi',
);

// Applied before tokenising. Fixes the single biggest measured miss: the old
// /\bbackend\b/ never matched "Back End Engineer".
const COMPOUND_FIXUPS = [
  [/\bback[\s-]end\b/gi, 'backend'],
  [/\bfront[\s-]end\b/gi, 'frontend'],
  [/\bfull[\s-]stack\b/gi, 'fullstack'],
  [/\bdev[\s-]ops\b/gi, 'devops'],
  [/\bdata[\s-]base\b/gi, 'database'],
  [/\bmachine[\s-]learning\b/gi, 'machine learning'],
  [/\bui\s*\/\s*ux\b/gi, 'ui ux'],
  [/\bux\s*\/\s*ui\b/gi, 'ui ux'],
  [/\bweb[\s-]site\b/gi, 'website'],
  [/\bq\.?a\.?\b/gi, 'qa'],
  [/\bsr\.?\b/gi, 'senior'],
  [/\bjr\.?\b/gi, 'junior'],
];

// Stripped only from the LEADING run and from a trailing level marker. Never
// mid-string: "Clinical Research Associate" and "Investment Analyst/Associate"
// have `Associate` as a real head noun.
const LEADING_SENIORITY = new RegExp(
  '^(?:\\s*(?:senior|junior|lead|principal|staff|head\\s+of|entry[\\s-]level|mid[\\s-]level'
  + '|experienced|graduate|trainee|intern|internship|working\\s+student|apprentice|founding'
  + '|deputy|global|regional|advanced|associate)\\b[\\s,\\-]*)+',
  'i',
);
const TRAILING_LEVEL = /[\s,-]*\b(?:i{1,3}|iv|v|[1-9])\b\s*$/i;

// Segments are scored independently; only the best one is the head.
const SEGMENT_SPLIT = /\s+[-–—|@]\s+|\s*,\s*|\s*\/\s{1,}/;

const STOPWORDS = new Set([
  'the', 'of', 'for', 'and', 'a', 'an', 'with', 'in', 'to', 'at', 'on', 'our',
  'new', 'm', 'f', 'd', 'w', 'x', 'we', 'are', 'is', 'as', 'by', 'or', 'you',
]);

// ---------------------------------------------------------------------------
// Reject — titles that must classify to nothing at all.
// Distinct from lib/jobFilter.js's ingestion deny-list on purpose: this decides
// CLASSIFICATION, that decides INGESTION. They overlap; they change separately.
// ---------------------------------------------------------------------------
const REJECT_PATTERNS = [
  /\bhiring\b\s*$/i,
  /\bwe(?:'re| are)\s+hiring\b/i,
  /\btalent\s+pool\b/i,
  /\bopen\s+application\b/i,
  /\bspeculative\s+application\b/i,
  /\binitiativbewerbung\b/i,
  /^\s*(?:various|multiple|other)\s+(?:roles?|positions?)\s*$/i,
  // Roles with no home anywhere in the 392-node taxonomy.
  /\bdelivery\s+(?:boy|partner|executive|rider)\b/i,
  /\bpicker\b|\bpacker\b|\bfulfil?lment\s+associate\b|\bsorting\s+associate\b/i,
  /\bpramoter\b|\bpromoter\b/i,
  /\bwaiter\b|\bwaitress\b|\bbarista\b|\bbartender\b|\bchef\b|\bcook\b/i,
  /\bcleaner\b|\bjanitor\b|\bhousekeep/i,
  /\bsecurity\s+guard\b|\bwatchman\b/i,
  /\bdriver\b|\bchauffeur\b|\bcourier\b|\bforklift\b/i,
  /\bnurse\b|\bnursing\b|\bmidwife\b|\bcaregiver\b/i,
  /\bhairdresser\b|\bbarber\b|\bbeautician\b/i,
];

// ---------------------------------------------------------------------------
// Curated rules: pattern -> exact leaf name.
// Seeded from the 60 real uncategorised titles measured 2026-09-18, where 80%
// of titles matched none of the previous 93 patterns.
// ---------------------------------------------------------------------------
const RULES = [
  // --- Software: languages, stacks, platforms -----------------------------
  { p: /\b\.net\b|\bc#\b|\bdotnet\b|\basp\.net\b/i, c: '.Net Engineer', w: NORMAL },
  { p: /\bbackend\b|\bserver[\s-]side\b/i, c: 'Backend Engineer', w: NORMAL },
  { p: /\bfrontend\b|\bui\s+developer\b/i, c: 'Frontend Software Engineer', w: NORMAL },
  { p: /\bfullstack\b/i, c: 'Full Stack Engineer', w: NORMAL },
  { p: /\breact\b|\bnext\.?js\b/i, c: 'React Developer', w: NORMAL },
  { p: /\bandroid\b|\bkotlin\b/i, c: 'Android Developer', w: NORMAL },
  { p: /\bios\b|\bswift\b/i, c: 'iOS/Swift Developer', w: NORMAL },
  { p: /\bflutter\b/i, c: 'Flutter Developer', w: NORMAL },
  { p: /\bpython\b/i, c: 'Python Engineer', w: NORMAL },
  { p: /\bjava\b(?!script)/i, c: 'Java Engineer', w: NORMAL },
  { p: /\bgolang\b|\bgo\s+(?:developer|engineer)\b/i, c: 'Golang Engineer', w: NORMAL },
  { p: /\bc\+\+\b|\bc\/c\+\+\b/i, c: 'C/C++ Engineer', w: NORMAL },
  { p: /\bsalesforce\s+(?:developer|engineer)\b/i, c: 'Salesforce Developer', w: NORMAL },
  { p: /\bsalesforce\s+admin/i, c: 'Salesforce Administrator', w: NORMAL },
  { p: /\bblockchain\b|\bweb3\b|\bsolidity\b|\bsmart\s+contract\b/i, c: 'Blockchain Engineer', w: NORMAL },
  { p: /\bunity\b/i, c: 'Unity Developer', w: NORMAL },
  { p: /\bunreal\b/i, c: 'Unreal Engine Developer', w: NORMAL },
  { p: /\bgame\s+(?:developer|programmer)\b/i, c: 'Game Developer', w: NORMAL },
  { p: /\bgame\s+design/i, c: 'Game Designer', w: NORMAL },
  { p: /\bar\s*\/\s*vr\b|\baugmented\s+reality\b|\bvirtual\s+reality\b|\bxr\b/i, c: 'AR/VR Developer', w: NORMAL },

  // --- Software: data / ML ------------------------------------------------
  { p: /\bdata\s+scien/i, c: 'Data Scientist', w: NORMAL },
  { p: /\bdata\s+eng/i, c: 'Data Engineer', w: NORMAL },
  { p: /\bdata\s+analyst\b|\banalytics\s+analyst\b/i, c: 'Data Analyst', w: NORMAL },
  { p: /\bbi\s+(?:analyst|developer)\b|\bbusiness\s+intelligence\b/i, c: 'Business/BI Analyst', w: NORMAL },
  { p: /\bpower\s*bi\b/i, c: 'Power BI Developer', w: NORMAL },
  { p: /\betl\b/i, c: 'ETL Developer', w: NORMAL },
  { p: /\bdata\s+warehouse\b/i, c: 'Data Warehouse Engineer', w: NORMAL },
  { p: /\bmachine\s+learning\b|\bml\s+engineer\b/i, c: 'Machine Learning Engineer', w: NORMAL },
  { p: /\bcomputer\s+vision\b/i, c: 'Machine Learning, Computer Vision', w: STRONG },
  { p: /\bdeep\s+learning\b/i, c: 'Machine Learning, Deep Learning', w: STRONG },
  { p: /\bml\s*ops\b|\bmlops\b/i, c: 'Machine Learning, Operations (ML Ops)', w: STRONG },
  { p: /\bai\s+engineer\b|\bartificial\s+intelligence\s+engineer\b/i, c: 'AI Engineer', w: NORMAL },
  { p: /\bllm\b|\blarge\s+language\s+model\b|\bgen\s*ai\b|\bgenerative\s+ai\b/i, c: 'LLM Engineer', w: NORMAL },
  { p: /\b(?:ai|ml)\s+research(?:er)?\b/i, c: 'Machine Learning/AI Researcher', w: NORMAL },
  { p: /\bdata\s+annotation\b|\bai\s+tutor\b/i, c: 'Data Annotation/AI Tutor', w: STRONG },

  // --- Software: infra / security / ops -----------------------------------
  { p: /\bdevops\b|\bci\s*\/\s*cd\b|\bplatform\s+engineer(?:ing)?\b/i, c: 'DevOps', w: NORMAL },
  { p: /\bsre\b|\bsite\s+reliability\b/i, c: 'Site Reliability Engineer (SRE)', w: NORMAL },
  { p: /\bcloud\s+(?:security|engineer|architect)\b/i, c: 'Cloud Security Engineer', w: WEAK },
  { p: /\bcyber\s*security\s+analyst\b|\bsecurity\s+analyst\b/i, c: 'Cyber Security Analyst', w: NORMAL },
  { p: /\bcyber\s*security\b|\binfo\s*sec\b|\bapplication\s+security\b|\bdevsecops\b/i, c: 'Cyber Security Engineer', w: NORMAL },
  { p: /\bnetwork\s+security\b/i, c: 'Network Security Engineer', w: NORMAL },
  { p: /\bsoc\s+analyst\b/i, c: 'SoC Analyst', w: STRONG },
  { p: /\bsystems?\s+engineer\b/i, c: 'Systems Engineer', w: WEAK },
  { p: /\bdatabase\s+admin|\bdba\b/i, c: 'Database Administrator', w: NORMAL },
  { p: /\bsystem\s+admin|\bsysadmin\b/i, c: 'System Administrator', w: NORMAL },
  { p: /\bhelp\s*desk\b|\bdesktop\s+support\b/i, c: 'Help Desk Technician/Desktop Support Technician', w: NORMAL },
  { p: /\bit\s+support\b|\bapplication\s+support\b/i, c: 'IT Support Specialist', w: NORMAL },
  { p: /\bnetwork\s+support\b/i, c: 'Network Support Specialist', w: NORMAL },

  // --- Software: QA -------------------------------------------------------
  { p: /\bautomation\s+(?:test|qa)\b|\btest\s+automation\b/i, c: 'Automation Test Engineer', w: NORMAL },
  { p: /\bqa\s+manager\b|\btest\s+manager\b/i, c: 'QA Manager', w: NORMAL },
  { p: /\bqa\b|\bquality\s+assurance\s+engineer\b|\btest\s+engineer\b|\btester\b|\bmanual\s+testing\b/i,
    c: 'Software Testing/Quality Assurance Engineer', w: WEAK },

  // --- Software: leadership / adjacent ------------------------------------
  { p: /\bcto\b|\bchief\s+technology\b/i, c: 'CTO', w: STRONG },
  { p: /\bengineering\s+(?:director|vp)\b|\bvp\s+(?:of\s+)?engineering\b/i, c: 'Engineering Director/VP', w: NORMAL },
  { p: /\bengineering\s+manager\b/i, c: 'Engineering Manager', w: NORMAL },
  { p: /\bsoftware\s+architect\b/i, c: 'Software Architect', w: NORMAL },
  { p: /\bsolutions?\s+architect\b|\bforward\s+deployed\b/i, c: 'Solutions Architect/Forward Deployed Engineer', w: NORMAL },
  { p: /\bsolutions?\s+engineer\b/i, c: 'Sales Engineer (Technical Sales)', w: NORMAL },
  { p: /\bcloud\s+(?:operations|ops)\b|\bcloud\s+infrastructure\b/i, c: 'DevOps', w: NORMAL },
  { p: /\bdev\s*rel\b|\bdeveloper\s+(?:relations|advocate)\b/i, c: 'Developer Relations', w: STRONG },
  { p: /\btechnical\s+account\s+manager\b/i, c: 'Technical Account Manager', w: STRONG },
  { p: /\btechnical\s+writ/i, c: 'Technical Writing', w: NORMAL },
  { p: /\bscrum\s+master\b/i, c: 'Scrum Master', w: STRONG },
  { p: /\btechnical\s+(?:project|program)\s+manager\b/i, c: 'Technical Project Manager', w: NORMAL },
  { p: /\bproject\s+lead\b|\bdelivery\s+lead\b/i, c: 'Technical Project Manager', w: NEAREST },

  // --- Product ------------------------------------------------------------
  { p: /\bai\s+product\s+manager\b/i, c: 'AI Product Manager', w: STRONG },
  { p: /\bproduct\s+analyst\b/i, c: 'Product Analyst', w: NORMAL },
  { p: /\bproduct\s+(?:manager|owner)\b|\bdirector\s+of\s+product\b|\bhead\s+of\s+product\b/i, c: 'Product Manager', w: NORMAL },

  // --- Creative & Design --------------------------------------------------
  { p: /\bux\s+research/i, c: 'UX Researcher', w: STRONG },
  { p: /\bux\s+design|\buser\s+experience\s+design/i, c: 'UX Designer', w: NORMAL },
  { p: /\bui\s+design|\buser\s+interface\s+design/i, c: 'UI Designer', w: NORMAL },
  { p: /\bui\s+ux\b/i, c: 'UI/UX Developer', w: NORMAL },
  // No `Product Designer` leaf exists; UX Designer is the nearest. High volume.
  { p: /\bproduct\s+designer\b/i, c: 'UX Designer', w: NEAREST },
  { p: /\bgraphic\s+design/i, c: 'Graphic Designer', w: NORMAL },
  { p: /\bmotion\s+design/i, c: 'Motion Designer', w: NORMAL },
  { p: /\b3d\s+(?:design|artist)/i, c: '3D Designer', w: NORMAL },
  { p: /\banimator\b|\banimation\b/i, c: 'Animator', w: NORMAL },
  { p: /\billustrator\b/i, c: 'Illustrator', w: NORMAL },
  { p: /\bvideo\s+edit/i, c: 'Video Editor', w: NORMAL },
  { p: /\b(?:creative|art)\s+director\b/i, c: 'Creative/Art Director', w: NORMAL },
  { p: /\binterior\s+design/i, c: 'Interior Designer', w: NORMAL },
  { p: /\bindustrial\s+design/i, c: 'Industrial Designer', w: NORMAL },

  // --- Marketing ----------------------------------------------------------
  { p: /\bbrand\s+manager\b|\bbrand\s+lead\b/i, c: 'Brand Manager', w: NORMAL },
  { p: /\bcommunity\s+manager\b/i, c: 'Community Manager', w: NORMAL },
  { p: /\bevent\s+market/i, c: 'Event Marketing Specialist', w: NORMAL },
  { p: /\bpublic\s+relations\b|\bpr\s+manager\b|\bcommunications?\s+manager\b/i, c: 'Public Relations', w: NORMAL },
  { p: /\badvertising\b/i, c: 'Advertising Specialist', w: NORMAL },
  { p: /\bgrowth\s+market|\bgrowth\s+manager\b|\bgrowth\s+lead\b/i, c: 'Growth Marketing (Growth Marketing)', w: NORMAL },
  { p: /\bperformance\s+market|\bpaid\s+(?:media|search|social)\b|\bsem\b/i, c: 'Performance Marketing', w: NORMAL },
  { p: /\bemail\s+market/i, c: 'Email Marketing', w: NORMAL },
  { p: /\blifecycle\s+market|\bcrm\s+manager\b/i, c: 'Lifecycle Marketing', w: NORMAL },
  { p: /\bproduct\s+market/i, c: 'Product Marketing (Product Marketing)', w: NORMAL },
  { p: /\bcontent\s+(?:market|strateg)/i, c: 'Content Marketing/Strategy', w: NORMAL },
  { p: /\bcopywriter\b|\bcontent\s+writer\b/i, c: 'Copywriter', w: NORMAL },
  { p: /\bseo\b/i, c: 'SEO', w: NORMAL },
  { p: /\bsocial\s+media\b/i, c: 'Social Media Management', w: NORMAL },
  { p: /\bmarket\s+development\s+manager\b/i, c: 'Growth Marketing (Growth Marketing)', w: NEAREST },
  // No "Marketing Analyst" leaf; Market Research Analyst is the nearest.
  { p: /\bmarketing\s+analyst\b/i, c: 'Market Research Analyst', w: NEAREST },
  // Generic fallback for the Marketing root: bare "Marketing Manager",
  // "Head of Marketing". Sits at DEFAULT so any specific marketing rule
  // above displaces it through the top-k window.
  { p: /\bmarketing\b/i, c: 'Content Marketing/Strategy', w: DEFAULT },

  // --- Sales --------------------------------------------------------------
  { p: /\bbusiness\s+development\b|\bbd\s+manager\b|\bbizdev\b/i, c: 'Business Development (Business Development)', w: NORMAL },
  { p: /\baccount\s+executive\b/i, c: 'Account Executive, SMB', w: NORMAL },
  { p: /\bsales\s+development\s+rep|\bsdr\b|\bbdr\b/i, c: 'Sales Development Representative', w: NORMAL },
  { p: /\binside\s+sales\b/i, c: 'Inside Sales Representative', w: NORMAL },
  { p: /\bfield\s+sales\b|\boutside\s+sales\b/i, c: 'Field Sales Representative', w: NORMAL },
  { p: /\benterprise\s+sales\b|\bkey\s+account\s+manager\b/i, c: 'Enterprise Sales', w: NORMAL },
  { p: /\bchannel\s+sales\b|\bpartner\s+sales\b/i, c: 'Channel Sales', w: NORMAL },
  { p: /\bpartnerships?\b/i, c: 'Partnership', w: NORMAL },
  { p: /\bsales\s+(?:director|vp)\b|\bvp\s+(?:of\s+)?sales\b|\bchief\s+revenue\b/i, c: 'Sales Director/VP', w: NORMAL },
  { p: /\bregional\s+sales\s+manager\b/i, c: 'Regional Sales Manager', w: NORMAL },
  { p: /\bsales\s+manager\b/i, c: 'Sales Manager', w: NORMAL },
  { p: /\bsales\s+executive\b/i, c: 'Account Executive, SMB', w: NORMAL },
  { p: /\bpre[\s-]?sales\b/i, c: 'Sales Engineer (Technical Sales)', w: NORMAL },
  { p: /\bsales\s+(?:specialist|consultant)\b/i, c: 'Sales Manager', w: NEAREST },
  { p: /\bsales\s+operations?\b/i, c: 'Sales Operations Specialist', w: NORMAL },
  { p: /\bsales\s+support\b/i, c: 'Sales Support', w: NORMAL },
  { p: /\bmedical\s+device\s+sales\b/i, c: 'Medical Device Sales', w: STRONG },
  { p: /\binsurance\s+sales\b/i, c: 'Insurance Sales', w: NORMAL },
  { p: /\bfinancial\s+advisor\b/i, c: 'Financial Advisor', w: NORMAL },
  { p: /\bstore\s+manager\b/i, c: 'Store Manager', w: NORMAL },
  // No generic "Sales Associate" leaf; retail is the dominant reading on
  // GulfTalent/NaukriGulf where this title is most common.
  { p: /\bsales\s+associate\b/i, c: 'Retail Sales (Retail Sales)', w: NEAREST },

  // --- Customer Service ---------------------------------------------------
  { p: /\bcustomer\s+success\b/i, c: 'Customer Success (Customer Success)', w: NORMAL },
  { p: /\bcustomer\s+(?:support|care)\b|\btechnical\s+support\b/i, c: 'Customer Support (Customer Support)', w: NORMAL },
  { p: /\bcustomer\s+service\s+manager\b/i, c: 'Customer Service Manager', w: NORMAL },
  { p: /\bcustomer\s+service\b|\bcustomer\s+experience\b/i, c: 'Customer Service Representative', w: NORMAL },

  // --- Finance ------------------------------------------------------------
  { p: /\bfinancial\s+analyst\b/i, c: 'Financial Analyst', w: NORMAL },
  { p: /\bcorporate\s+finance\b|\bfinance\s+(?:manager|director|business\s+partner)\b|\bfp&a\b/i,
    c: 'Corporate Finance Analyst', w: NEAREST },
  { p: /\binvestment\s+bank/i, c: 'Investment Banker', w: NORMAL },
  { p: /\bcredit\s+analyst\b|\bcredit\s+report/i, c: 'Credit Analyst', w: NORMAL },
  { p: /\bloan\s+officer\b/i, c: 'Loan Officer', w: NORMAL },
  { p: /\btreasury\b|\btreasurer\b/i, c: 'Treasury', w: NORMAL },
  { p: /\bactuar/i, c: 'Actuary', w: STRONG },
  { p: /\bunderwriter\b/i, c: 'Underwriter', w: STRONG },
  { p: /\bequity\s+(?:analyst|research)\b/i, c: 'Equity Analyst', w: NORMAL },
  { p: /\bportfolio\s+manager\b/i, c: 'Portfolio Manager', w: NORMAL },
  { p: /\bquant(?:itative)?\s+(?:analyst|research)/i, c: 'Quantitative Analyst/Researcher', w: NORMAL },
  { p: /\bsecurities\s+trader\b|\btrader\b/i, c: 'Securities Trader', w: NORMAL },
  { p: /\basset\s+manager\b/i, c: 'Asset Manager', w: NORMAL },
  { p: /\binvestor\s+relations\b/i, c: 'Investor Relations Manager', w: STRONG },
  { p: /\bfundraising\s+manager\b/i, c: 'Fundraising Manager', w: NORMAL },
  { p: /\bcommercial\s+bank/i, c: 'Commercial Banker', w: NORMAL },
  // "Strategic Finance Controller" and similar land in Accounting, not Finance.
  { p: /\bcontroller\b|\bcontrolling\b/i, c: 'Controller', w: NORMAL },

  // --- Accounting ---------------------------------------------------------
  { p: /\baccountant\b|\baccounting\b|\bbookkeep/i, c: 'Accountant', w: NORMAL },
  { p: /\bauditor\b|\baudit\s+manager\b|\binternal\s+audit\b/i, c: 'Auditor', w: NORMAL },
  { p: /\btax\s+(?:specialist|manager|advisor|accountant)\b/i, c: 'Tax Specialist', w: NORMAL },

  // --- HR / Admin / Legal (the combined root) -----------------------------
  { p: /\bhr\s+business\s+partner\b|\bpeople\s+partner\b|\bemployee\s+relations\b/i, c: 'HR Business Partner', w: NORMAL },
  { p: /\bhr\s+(?:manager|director)\b|\bhead\s+of\s+people\b|\bchro\b/i, c: 'Human Resource Manager/Director', w: NORMAL },
  { p: /\bhr\s+specialist\b|\bhuman\s+resources?\b|\bpeople\s+operations?\b/i, c: 'Human Resource Specialist', w: NORMAL },
  { p: /\bpayroll\b/i, c: 'Payroll Specialist', w: NORMAL },
  { p: /\brecruiter\b|\bsourcer\b|\btalent\s+acquisition\b|\brecruitment\b/i, c: 'Recruiter/Sourcer', w: NORMAL },
  { p: /\brecruiting\s+coordinator\b/i, c: 'Recruiting Coordinator', w: NORMAL },
  { p: /\bexecutive\s+assistant\b/i, c: 'Executive Assistant', w: NORMAL },
  { p: /\badministrative\s+assistant\b|\badmin\s+assistant\b/i, c: 'Administrative Assistant', w: NORMAL },
  { p: /\badministrative\s+(?:coordinator|officer|specialist)\b/i, c: 'Administrative Assistant', w: NORMAL },
  { p: /\boffice\s+manager\b/i, c: 'Office Manager', w: NORMAL },
  { p: /\breceptionist\b/i, c: 'Receptionist', w: STRONG },
  { p: /\bdata\s+entry\b/i, c: 'Data Entry Clerk', w: NORMAL },
  { p: /\bchief\s+of\s+staff\b/i, c: 'Chief of Staff', w: STRONG },
  { p: /\bcorporate\s+counsel\b|\bgeneral\s+counsel\b|\bcounsel\b/i, c: 'Corporate Counsel', w: NORMAL },

  // --- Legal Services -----------------------------------------------------
  { p: /\bcompliance\b/i, c: 'Compliance Specialist', w: NORMAL },
  { p: /\bparalegal\b/i, c: 'Paralegal (Paralegals & Legal Support)', w: NORMAL },
  { p: /\blegal\s+assistant\b/i, c: 'Legal Assistant', w: NORMAL },
  { p: /\blegal\s+operations?\b/i, c: 'Legal Operations Manager', w: NORMAL },
  { p: /\blitigation\b/i, c: 'Litigation Lawyer', w: NORMAL },
  { p: /\bintellectual\s+property\b|\bip\s+(?:lawyer|counsel)\b|\bpatent\s+attorney\b/i, c: 'Intellectual Property Lawyer', w: NORMAL },
  { p: /\bimmigration\s+(?:lawyer|attorney)\b/i, c: 'Immigration Lawyer', w: NORMAL },
  { p: /\bfamily\s+(?:lawyer|attorney)\b/i, c: 'Family Lawyer', w: NORMAL },
  { p: /\bcriminal\s+(?:lawyer|attorney)\b/i, c: 'Criminal Lawyer', w: NORMAL },
  { p: /\bcase\s+manager\b/i, c: 'Case Manager', w: NORMAL },
  { p: /\bcourt\s+clerk\b/i, c: 'Court Clerk', w: STRONG },
  { p: /\brisk\s+(?:analyst|manager)\b/i, c: 'Risk Analyst (Compliance & Risk Management)', w: NORMAL },

  // --- Consulting ---------------------------------------------------------
  { p: /\bbusiness\s+strategy\b|\bstrategy\s+(?:manager|consultant|director)\b/i, c: 'Business Strategy Consultant', w: NORMAL },
  { p: /\bchange\s+management\b/i, c: 'Change Management Consultant', w: NORMAL },
  { p: /\bmarket\s+research\b/i, c: 'Market Research Analyst', w: NORMAL },
  { p: /\boperations\s+consultant\b/i, c: 'Operations Consultant', w: NORMAL },
  { p: /\bfinancial\s+consultant\b|\bfinancial\s+advisory\b/i, c: 'Financial Consultant', w: NORMAL },
  { p: /\bm&a\b|\bmergers\b/i, c: 'Mergers & Acquisitions (M&A) Consultant', w: NORMAL },
  { p: /\bit\s+consultant\b|\bsap\b(?=.*\bconsultant\b)|\berp\s+consultant\b/i, c: 'IT Consultant', w: NORMAL },
  { p: /\bbusiness\s+analyst\b|\bfunctional\s+\w*\s*consultant\b/i, c: 'Business Analyst', w: NORMAL },
  { p: /\bdata\s+consultant\b/i, c: 'Data Consultant', w: NORMAL },
  // Generic fallback for the Consulting root: "Principal Consultant",
  // "Senior LIMS Consultant" etc. Sits at DEFAULT so any specific
  // consulting rule above displaces it through the top-k window.
  { p: /\bconsultant\b/i, c: 'Business Strategy Consultant', w: DEFAULT },
  { p: /\bsecurity\s+consultant\b/i, c: 'Cyber Security Consultant', w: NORMAL },

  // --- Healthcare (scientific / biotech — no clinical bedside leaves) ------
  { p: /\bbiomedical\s+engineer\b/i, c: 'Biomedical Engineer', w: STRONG },
  { p: /\bclinical\s+engineer\b/i, c: 'Clinical Engineer', w: STRONG },
  { p: /\bbiostatistician\b|\bbiostatistics\b/i, c: 'Biostatistician', w: STRONG },
  { p: /\bclinical\s+research\s+associate\b|\bcra\b/i, c: 'Clinical Research Associate', w: STRONG },
  { p: /\bclinical\s+research\s+scientist\b|\bclinical\s+scientist\b/i, c: 'Clinical Research Scientist', w: STRONG },
  { p: /\bclinical\s+operations?\b/i, c: 'Clinical Operations Manager', w: NORMAL },
  { p: /\bmedical\s+writer?\b/i, c: 'Medical Writer', w: STRONG },
  { p: /\bregulatory\s+affairs\b/i, c: 'Regulatory Affairs Specialist', w: STRONG },
  { p: /\bbiochemist\b/i, c: 'Biochemist', w: STRONG },
  { p: /\bbiologist\b|\bmicrobiolog/i, c: 'Biologist', w: STRONG },
  { p: /\bchemist\b(?!ry\s+teacher)/i, c: 'Chemist', w: NORMAL },
  { p: /\bpharmacolog/i, c: 'Pharmacologist', w: STRONG },
  { p: /\btoxicolog/i, c: 'Toxicologist', w: STRONG },
  { p: /\bdmpk\b/i, c: 'DMPK Scientist', w: STRONG },
  { p: /\bformulation\s+scientist\b/i, c: 'Formulation Scientist', w: STRONG },
  { p: /\bhealth\s+product\s+manager\b/i, c: 'Health Product Manager', w: STRONG },
  { p: /\bhealthcare\s+compliance\b/i, c: 'Healthcare Compliance Manager', w: STRONG },
  { p: /\bhealthcare\s+data\s+analyst\b/i, c: 'Healthcare Data Analyst', w: STRONG },
  { p: /\bhealthcare\s+data\s+scientist\b/i, c: 'Healthcare Data Scientist', w: STRONG },
  { p: /\bhealthcare\s+it\b|\bhealth\s+informatics\b/i, c: 'Healthcare IT Specialist', w: STRONG },
  { p: /\behr\b|\belectronic\s+health\s+record/i, c: 'EHR (Electronic Health Records) System Administrator', w: NORMAL },

  // --- Education and Training ---------------------------------------------
  { p: /\bprofessor\b|\blecturer\b|\bhigher\s+education\b|\bpostdoc/i, c: 'Higher Education Teaching', w: NORMAL },
  { p: /\bteacher\b|\bk-12\b|\bschool\s+teacher\b|\bprimary\s+teacher\b/i, c: 'K-12 Teaching', w: NORMAL },
  { p: /\bcorporate\s+train|\bl&d\b|\blearning\s+and\s+development\b|\binstructional\s+design/i,
    c: 'Corporate Training and Development (Corporate Training and Development)', w: NORMAL },
  { p: /\bacademic\s+dean\b|\bdean\b/i, c: 'Academic Dean', w: NORMAL },
  { p: /\beducational?\s+admin/i, c: 'Educational Administration (Educational Administration)', w: NORMAL },
  // PhD/research fellowships are the dominant WorkInDenmark shape.
  { p: /\bphd\s+(?:scholarship|fellowship|position|student)\b|\bdoctoral\b/i, c: 'Higher Education Teaching', w: NEAREST },

  // --- Public Sector and Government ---------------------------------------
  { p: /\bpolicy\s+(?:analyst|advisor|officer)\b/i, c: 'Policy Analyst', w: NORMAL },
  { p: /\bgovernment\s+relations\b|\bpublic\s+affairs\b/i, c: 'Government Relations Manager', w: NORMAL },
  { p: /\bfundraising\s+coordinator\b/i, c: 'Fundraising Coordinator', w: NORMAL },
  { p: /\bvolunteer\s+coordinator\b/i, c: 'Volunteer Coordinator', w: STRONG },
  { p: /\bprogram\s+manager\b/i, c: 'Program Manager', w: WEAK },

  // --- Logistics / Supply Chain -------------------------------------------
  { p: /\bsupply\s+chain\b/i, c: 'Supply Chain Manager', w: NORMAL },
  { p: /\blogistics?\b/i, c: 'Logistics Manager', w: NORMAL },
  { p: /\bwarehouse\s+manager\b/i, c: 'Warehouse Manager', w: NORMAL },
  { p: /\bprocurement\b|\bpurchasing\s+manager\b|\bbuyer\b/i, c: 'Procurement Manager', w: NORMAL },
  { p: /\binventory\b/i, c: 'Inventory Manager', w: NORMAL },
  { p: /\bfacilities\b/i, c: 'Facilities Manager', w: NORMAL },
  { p: /\bdistribution\s+cent(?:er|re)\b/i, c: 'Distribution Center Manager', w: NORMAL },

  // --- Production / Manufacturing -----------------------------------------
  { p: /\bmechanical\s+engineer\b/i, c: 'Mechanical Engineer', w: NORMAL },
  { p: /\bmanufacturing\s+engineer\b/i, c: 'Manufacturing Engineer', w: NORMAL },
  { p: /\bindustrial\s+engineer\b/i, c: 'Industrial Engineer', w: NORMAL },
  { p: /\bprocess\s+engineer\b/i, c: 'Process Engineer', w: NORMAL },
  { p: /\bmechatronics\b/i, c: 'Mechatronics Engineer', w: STRONG },
  { p: /\bchemical\s+engineer\b/i, c: 'Chemical Engineer', w: NORMAL },
  { p: /\bautomotive\s+engineer\b/i, c: 'Automotive Engineer', w: NORMAL },
  { p: /\bautonomous\s+driving\b|\badas\b/i, c: 'Autonomous Driving System Engineer', w: STRONG },
  { p: /\bpowertrain\b/i, c: 'Powertrain Engineer', w: STRONG },
  { p: /\bsafety\s+engineer\b/i, c: 'Safety Engineer', w: NORMAL },
  { p: /\behs\b|\bhsse?q?\b|\bhealth,?\s+safety\b/i, c: 'EHS (Environment, Health, Safety) Engineer', w: NORMAL },
  { p: /\blab(?:oratory)?\s+technician\b/i, c: 'Laboratory Technician', w: NORMAL },
  { p: /\bquality\s+(?:assurance\s+specialist|manager|engineer|specialist)\b/i, c: 'Quality Assurance Specialist', w: WEAK },
  { p: /\boperations\s+(?:manager|director|supervisor)\b/i, c: 'Operations Manager/Director', w: NORMAL },

  // --- Electrical Engineering ---------------------------------------------
  { p: /\belectrical\s+engineer\b/i, c: 'Electrical Engineer', w: NORMAL },
  { p: /\baerospace\s+engineer\b|\bavionics\b/i, c: 'Aerospace Engineer', w: NORMAL },
  { p: /\bautomation\s+engineer\b/i, c: 'Automation Engineer', w: NORMAL },
  { p: /\bcontrols?\s+engineer\b/i, c: 'Controls Engineer', w: NORMAL },
  { p: /\brobotics\b/i, c: 'Robotics Engineer', w: NORMAL },
  { p: /\bbattery\s+engineer\b/i, c: 'Battery Engineer', w: STRONG },
  { p: /\basic\b/i, c: 'ASIC Engineer', w: STRONG },
  { p: /\bfpga\b/i, c: 'FPGA Engineer', w: STRONG },
  { p: /\bpcb\b/i, c: 'PCB Engineer', w: STRONG },
  { p: /\brf\s+engineer\b|\bradio\s+frequency\b/i, c: 'RF (Radio Frequency) Engineer', w: STRONG },
  { p: /\bhardware\s+engineer\b/i, c: 'Hardware Engineer', w: NORMAL },
  { p: /\belectronics?\s+engineer\b/i, c: 'Electronics Engineer', w: NORMAL },
  { p: /\bembedded\b|\bfirmware\b/i, c: 'Embedded Software Engineer', w: NORMAL },
  { p: /\btelecom/i, c: 'Telecommunications Engineer', w: NORMAL },
  { p: /\bantenna\b|\bwireless\s+engineer\b/i, c: 'Wireless/Antenna Engineer', w: STRONG },
  { p: /\bic\s+design\b/i, c: 'IC Design Engineer', w: STRONG },
  { p: /\bsystems?\s+integration\b/i, c: 'Systems Integration Engineer', w: NORMAL },
  { p: /\belectronic\s+warfare\b|\bew\s+specialist\b|\bavionics\s+system/i, c: 'Systems Integration Engineer', w: NORMAL },
  { p: /\bfield\s+application\s+engineer\b|\bfae\b/i, c: 'Sales Engineer (Sales & Technical Support)', w: NEAREST },
  { p: /\bsales\s+engineer\b/i, c: 'Sales Engineer (Technical Sales)', w: NORMAL },

  // --- Energy / Environmental ---------------------------------------------
  { p: /\benergy\s+engineer\b/i, c: 'Energy Engineer', w: NORMAL },
  { p: /\bnuclear\b/i, c: 'Nuclear Engineer', w: NORMAL },
  { p: /\bpower\s+systems?\b|\bgrid\s+engineer\b/i, c: 'Power Systems Engineer', w: NORMAL },
  { p: /\brenewable\b|\bsolar\s+engineer\b|\bwind\s+engineer\b|\bbess\b/i, c: 'Renewable Energy Engineer', w: NORMAL },
  { p: /\benvironmental\s+engineer\b/i, c: 'Environmental Engineer', w: NORMAL },
  { p: /\benvironmental\s+scientist\b|\bsustainability\b/i, c: 'Environmental Scientist', w: NORMAL },

  // --- Real Estate / Architecture -----------------------------------------
  { p: /\blandscape\s+architect\b/i, c: 'Landscape Architect', w: STRONG },
  { p: /\burban\s+plann/i, c: 'Urban Planner', w: STRONG },
  { p: /\bcivil\s+engineer\b/i, c: 'Civil Engineer', w: NORMAL },
  { p: /\bstructural\s+engineer\b/i, c: 'Structural Engineer', w: NORMAL },
  { p: /\bconstruction\s+(?:project\s+)?manager\b/i, c: 'Construction Project Manager', w: NORMAL },
  { p: /\bproperty\s+manager\b/i, c: 'Property Manager', w: NORMAL },
  { p: /\bleasing\s+consultant\b/i, c: 'Leasing Consultant', w: NORMAL },
  { p: /\bleasing\s+manager\b/i, c: 'Leasing Manager', w: NORMAL },
  { p: /\breal\s+estate\s+(?:agent|sales)\b/i, c: 'Real Estate Sales', w: NORMAL },
  { p: /\barchitect\b(?!ure\s+of)/i, c: 'Architect', w: WEAK },

  // --- Generic software floor --------------------------------------------
  // Scored at exactly THRESHOLD so it classifies bare "Developer",
  // "Software Development Engineer", "Advanced Software Engineer" etc., but is
  // displaced by the top-k window the moment any real rule (>= WEAK+) fires.
  { p: /\b(?:software\s+)?(?:developer|programmer|swe|sde)\b/i, c: 'Backend Engineer', w: DEFAULT },
  { p: /\bsoftware\s+engineer\b|\bsoftware\s+development\s+engineer\b/i, c: 'Backend Engineer', w: DEFAULT },
  { p: /\bengineer\b/i, c: 'Backend Engineer', w: DEFAULT },
];

// Feed/category names the scrapers pass in `job.categories`, mapped straight to
// a leaf. Jobicy and WWR supply these and they are more reliable than the title.
const SOURCE_CATEGORY_MAP = {
  'full-stack programming': 'Full Stack Engineer',
  'back-end programming': 'Backend Engineer',
  'front-end programming': 'Frontend Software Engineer',
  'devops and sysadmin': 'DevOps',
  'devops & sysadmin': 'DevOps',
  design: 'UI Designer',
  'customer support': 'Customer Support (Customer Support)',
  'sales and marketing': 'Sales Manager',
  'sales & marketing': 'Sales Manager',
  'management and finance': 'Corporate Finance Analyst',
  'management & finance': 'Corporate Finance Analyst',
  product: 'Product Manager',
  'human resources': 'Human Resource Specialist',
  'data science': 'Data Scientist',
  marketing: 'Content Marketing/Strategy',
  sales: 'Sales Manager',
  finance: 'Financial Analyst',
  legal: 'Corporate Counsel',
  engineering: 'Backend Engineer',
};

module.exports = {
  STRONG,
  NORMAL,
  NEAREST,
  DEFAULT,
  WEAK,
  GENDER_TAG,
  GENDER_WORD,
  EMPLOYMENT_NOISE,
  COMPOUND_FIXUPS,
  LEADING_SENIORITY,
  TRAILING_LEVEL,
  SEGMENT_SPLIT,
  STOPWORDS,
  REJECT_PATTERNS,
  RULES,
  SOURCE_CATEGORY_MAP,
};
