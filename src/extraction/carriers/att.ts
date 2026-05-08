import type {
  ExtractedAccount,
  ExtractedBill,
  ExtractedCredit,
  ExtractedDpp,
  ExtractedFeature,
  ExtractedLine,
  FeatureCategory,
} from '@/extraction/schema';

// Defense in depth: the LLM system prompt (src/extraction/llm.ts) already
// categorizes features and prints canonical plan names. This pass corrects
// well-known AT&T naming variants when the LLM slips.

const PLAN_CANONICAL: Array<{ pattern: RegExp; canonical: string }> = [
  {
    pattern: /^\s*business\s+unlimited\s+premium\s*$/i,
    canonical: 'Business Unlimited Premium',
  },
  {
    pattern: /^\s*business\s+unlimited\s+performance\s*$/i,
    canonical: 'Business Unlimited Performance',
  },
  {
    pattern: /^\s*business\s+unlimited\s+starter\s*$/i,
    canonical: 'Business Unlimited Starter',
  },
];

const FEATURE_CATEGORY_OVERRIDES: Array<{
  pattern: RegExp;
  category: FeatureCategory;
}> = [
  {
    pattern: /(at\s*&\s*t\s+mobile\s+insurance|mobile\s+protection\s+pack)/i,
    category: 'insurance',
  },
  { pattern: /international\s+day\s+pass/i, category: 'international' },
  { pattern: /at\s*&\s*t\s+photo\s+storage/i, category: 'cloud' },
];

export function normalize(bill: ExtractedBill): ExtractedBill {
  return {
    ...bill,
    accounts: bill.accounts.map(normalizeAccount),
  };
}

function normalizeAccount(account: ExtractedAccount): ExtractedAccount {
  return {
    ...account,
    account_level_credits: account.account_level_credits.map(normalizeCredit),
    lines: account.lines.map(normalizeLine),
  };
}

function normalizeLine(line: ExtractedLine): ExtractedLine {
  return {
    ...line,
    plan_name: canonicalizePlan(line.plan_name),
    features: line.features.map(normalizeFeature),
    credits: line.credits.map(normalizeCredit),
    dpp_installments: line.dpp_installments.map(normalizeDpp),
  };
}

function canonicalizePlan(plan: string | null): string | null {
  if (plan === null) return null;
  for (const { pattern, canonical } of PLAN_CANONICAL) {
    if (pattern.test(plan)) return canonical;
  }
  return plan;
}

function normalizeFeature(feature: ExtractedFeature): ExtractedFeature {
  for (const { pattern, category } of FEATURE_CATEGORY_OVERRIDES) {
    if (pattern.test(feature.name)) {
      return { ...feature, category };
    }
  }
  return feature;
}

function normalizeCredit(credit: ExtractedCredit): ExtractedCredit {
  const trimmed = credit.name.trim();
  if (trimmed === credit.name) return credit;
  return { ...credit, name: trimmed };
}

// AT&T labels DPP variously ("Next Up", "Equipment Installment Plan"). Leave
// the labeling alone — what matters for rules is the device. Just trim it.
function normalizeDpp(dpp: ExtractedDpp): ExtractedDpp {
  const device = dpp.device.trim().replace(/\s+/g, ' ');
  if (device === dpp.device) return dpp;
  return { ...dpp, device };
}
