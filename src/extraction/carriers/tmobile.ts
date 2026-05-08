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
// well-known T-Mobile naming variants when the LLM slips.

const PLAN_CANONICAL: Array<{ pattern: RegExp; canonical: string }> = [
  {
    pattern: /^\s*business\s+unlimited\s+ultimate\s*$/i,
    canonical: 'Business Unlimited Ultimate',
  },
  {
    pattern: /^\s*business\s+unlimited\s+advanced\s*$/i,
    canonical: 'Business Unlimited Advanced',
  },
  {
    pattern: /^\s*business\s+unlimited\s+select\s*$/i,
    canonical: 'Business Unlimited Select',
  },
];

const FEATURE_CATEGORY_OVERRIDES: Array<{
  pattern: RegExp;
  category: FeatureCategory;
}> = [
  // Match "Protection<360>", "Protection 360", "Protection360"
  {
    pattern: /(protection\s*<?\s*360\s*>?|premium\s+handset\s+protection)/i,
    category: 'insurance',
  },
  { pattern: /magenta\s+international/i, category: 'international' },
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

// T-Mobile sometimes labels promos as "Bill Credit" without flagging them as
// promotional. Preserve the original name; just ensure is_promo is true.
function normalizeCredit(credit: ExtractedCredit): ExtractedCredit {
  const trimmed = credit.name.trim();
  const isBillCredit = /\bbill\s+credit\b/i.test(trimmed);
  const nextName = trimmed === credit.name ? credit.name : trimmed;
  const nextIsPromo = isBillCredit ? true : credit.is_promo;
  if (nextName === credit.name && nextIsPromo === credit.is_promo) return credit;
  return { ...credit, name: nextName, is_promo: nextIsPromo };
}
