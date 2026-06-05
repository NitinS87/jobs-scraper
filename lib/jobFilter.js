// Shared filters for new multi-vertical job sources (Cimix, Work in Denmark,
// GulfTalent, SourcingXpress). These boards carry many non-tech / non-English
// listings; the platform is tech + white-collar professional and English-focused,
// so scrapers use these helpers to drop irrelevant roles before/after detail fetch.

// Manual / service / trade roles we explicitly do NOT want. Checked first —
// exclusion always wins over the allowlist (e.g. "Restaurant Manager" → dropped).
const EXCLUDE_PATTERNS = [
  /\bnurse\b|\bnursing\b|\bcaregiver\b|\bcare\s*assistant\b|\bcare\s*worker\b|\bcaretaker\b/i,
  /\bdentist\b|\bdental\b|\bphysician\b|\bdoctor\b|\bsurgeon\b|\bmidwife\b|\bpharmacist\b|\bveterinar/i,
  /\bchef\b|\bcook\b|\bbaker\b|\bbutcher\b|\bbarista\b|\bbartender\b|\bwaiter\b|\bwaitress\b|\bdishwasher\b/i,
  /\bflorist\b|\bhairdresser\b|\bbarber\b|\bbeautician\b|\bmasseur\b|\bmassage\b|\btattoo\b/i,
  /\bdriver\b|\bchauffeur\b|\bcourier\b|\brider\b|\btrucker\b|\bforklift\b/i,
  /\bcleaner\b|\bcleaning\b|\bjanitor\b|\bhousekeep|\bmaid\b|\blaundry\b/i,
  /\belectrician\b|\bplumber\b|\bwelder\b|\bcarpenter\b|\bmason\b|\bpainter\b|\broofer\b|\bmechanic\b(?!al)|\bfitter\b|\blocksmith\b/i,
  /\bconstruction\s*worker\b|\blabou?rer\b|\bscaffolder\b|\bbricklayer\b|\bplasterer\b|\bgardener\b|\blandscaper\b/i,
  /\bwarehouse\b|\bpicker\b|\bpacker\b|\bstock\s*clerk\b|\bfactory\s*worker\b|\bassembler\b|\bmachine\s*operator\b/i,
  /\bcashier\b|\bcheckout\b|\bsales\s*assistant\b|\bshop\s*assistant\b|\bstore\s*clerk\b|\bretail\s*associate\b/i,
  /\bwaitstaff\b|\bhost(?:ess)?\b|\bhousekeeping\b|\broom\s*attendant\b|\bporter\b|\bvalet\b|\bconcierge\b/i,
  /\bsecurity\s*guard\b|\bwatchman\b|\bbouncer\b/i,
  /\bteacher\b|\bteaching\s*assistant\b|\bpreschool\b|\bdaycare\b|\bbabysitter\b|\bnanny\b|\bpedagog/i,
  /\bfarm\b|\bfarmer\b|\bfisher|\bharvest|\bagricultural\s*worker\b/i,
];

// Tech + white-collar professional roles we DO want.
const INCLUDE_PATTERNS = [
  // Engineering / software / tech
  /\b(software|backend|back-end|frontend|front-end|full[-\s]?stack|web|mobile|android|ios|game|embedded|firmware|systems?|platform|cloud|infrastructure|devops|sre|qa|test|automation|security|network|data|machine\s*learning|ml|ai|nlp|computer\s*vision|blockchain|robotics|hardware|electrical|mechanical|civil|chemical|aerospace|biomedical|process|manufacturing|quality)\s+engineer\b/i,
  /\bengineer(ing)?\b|\bdeveloper\b|\bprogrammer\b|\barchitect\b|\bdevops\b|\bsre\b|\bsysadmin\b|\badministrator\b/i,
  /\bdata\s*(scientist|analyst|engineer)\b|\bscientist\b|\banalyst\b|\bstatistician\b/i,
  /\bdesigner\b|\bux\b|\bui\b|\bproduct\s*design|\bgraphic\b|\bmotion\b|\banimator\b|\bart\s*director\b/i,
  /\bproduct\s*(manager|owner|lead)\b|\bproject\s*manager\b|\bprogram\s*manager\b|\bscrum\s*master\b|\bagile\b/i,
  // Business / professional
  /\bmanager\b|\bdirector\b|\bhead\s*of\b|\bchief\b|\blead\b|\bvp\b|\bvice\s*president\b|\bpresident\b|\bofficer\b|\bconsultant\b|\bspecialist\b|\bcoordinator\b|\bexecutive\b|\bassociate\b|\bstrategist\b/i,
  /\bmarketing\b|\bseo\b|\bsem\b|\bgrowth\b|\bbrand\b|\bcontent\b|\bcopywriter\b|\bcommunications?\b|\bpublic\s*relations\b|\bsocial\s*media\b/i,
  /\bsales\b|\bbusiness\s*develop|\baccount\s*(manager|executive)\b|\bpartnerships?\b|\brevenue\b/i,
  /\bfinance\b|\bfinancial\b|\baccountant\b|\baccounting\b|\bcontroller\b|\bauditor\b|\btreasur|\bbookkeep|\btax\b|\binvestment\b|\bactuar/i,
  /\bhr\b|\bhuman\s*resources?\b|\brecruit|\btalent\b|\bpeople\s*operations?\b/i,
  /\blegal\b|\blawyer\b|\battorney\b|\bcounsel\b|\bparalegal\b|\bcompliance\b|\bgovernance\b/i,
  /\boperations?\b|\bsupply\s*chain\b|\blogistics\b|\bprocurement\b|\bplanner\b|\bplanning\b/i,
  /\bcustomer\s*(success|support|service|experience)\b|\bsupport\s*engineer\b|\btechnical\s*support\b/i,
  /\bresearch|\bresearcher\b|\bphd\b|\bpostdoc\b|\bfellow\b|\bbioinformatic/i,
  /\blecturer\b|\bprofessor\b|\binstructor\b|\btrainer\b/i, // higher-ed kept; K-12/childcare teaching excluded above
  /\bwriter\b|\bedit(or|ing)\b|\bjournalist\b|\btranslator\b|\btechnical\s*writ/i,
];

/**
 * Returns true if the job title looks like a tech or white-collar professional
 * role worth ingesting. Exclusion patterns take precedence over inclusion.
 */
function isProfessionalRole(title) {
  if (!title) return false;
  const t = String(title);
  for (const re of EXCLUDE_PATTERNS) {
    if (re.test(t)) return false;
  }
  for (const re of INCLUDE_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

// Common Scandinavian / German stopwords that rarely appear in English titles.
// Note: deliberately excludes tokens that collide with English (e.g. "for").
const NON_ENGLISH_STOPWORDS = /\b(og|eller|med|til|søger|søges|medarbejder|erfaren|och|för|att|ett|samt|inom|söker|ledig\s+stilling|stilling|tjeneste|virksomhed|afdeling|kommune|sykepleier|ansvarlig|vår|våre)\b/i;

const NORDIC_CHARS = /[æøåäöÆØÅÄÖ]/g;

/**
 * Heuristic English-language check on a title (and optional description).
 * Rejects text with frequent Nordic characters or Scandinavian stopwords.
 * Conservative: when ambiguous, treats text as English to avoid dropping
 * legitimate English listings that merely contain a place name.
 */
function isLikelyEnglish(title, description = '') {
  const titleStr = String(title || '');
  if (!titleStr.trim()) return false;

  // Strong signal: Scandinavian stopwords in the title.
  if (NON_ENGLISH_STOPWORDS.test(titleStr)) return false;

  // Nordic-character density across title + a slice of the description.
  const sample = `${titleStr} ${String(description || '').slice(0, 600)}`;
  const letters = (sample.match(/[a-zA-ZæøåäöÆØÅÄÖ]/g) || []).length;
  const nordic = (sample.match(NORDIC_CHARS) || []).length;
  if (letters > 0 && nordic / letters > 0.04) return false;

  // Stopwords anywhere in the sampled description.
  if (description && NON_ENGLISH_STOPWORDS.test(String(description).slice(0, 600))) return false;

  return true;
}

module.exports = { isProfessionalRole, isLikelyEnglish };
