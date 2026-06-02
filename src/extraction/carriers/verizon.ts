import type {
  ExtractedAccount,
  ExtractedBill,
  ExtractedCredit,
  ExtractedFeature,
  ExtractedLine,
  FeatureCategory,
} from '@/extraction/schema';

// Defense in depth: the LLM system prompt (src/extraction/llm.ts) already
// categorizes features and prints canonical plan names. This pass corrects
// well-known Verizon naming variants when the LLM slips.

const PLAN_CANONICAL: Array<{ pattern: RegExp; canonical: string }> = [
  {
    pattern: /^\s*business\s+unlimited\s+pro\s+2\.?0\s*$/i,
    canonical: 'Business Unlimited Pro 2.0',
  },
  {
    pattern: /^\s*business\s+unlimited\s+plus\s+2\.?0\s*$/i,
    canonical: 'Business Unlimited Plus 2.0',
  },
  {
    pattern: /^\s*business\s+unlimited\s+start\s+2\.?0\s*$/i,
    canonical: 'Business Unlimited Start 2.0',
  },
];

const FEATURE_CATEGORY_OVERRIDES: Array<{
  pattern: RegExp;
  category: FeatureCategory;
}> = [
  { pattern: /verizon\s+cloud/i, category: 'cloud' },
  { pattern: /travel\s*pass/i, category: 'international' },
  {
    pattern: /(mobile\s+protect|total\s+mobile\s+protection|wireless\s+phone\s+protection)/i,
    category: 'insurance',
  },
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
  // Title-case "loyalty discount" variants regardless of how the LLM emitted it.
  const name = /^loyalty\s+discount$/i.test(trimmed) ? 'Loyalty Discount' : trimmed;
  if (name === credit.name) return credit;
  return { ...credit, name };
}
