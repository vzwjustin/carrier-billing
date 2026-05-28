import type {
  ExtractedAccount,
  ExtractedBill,
  ExtractedCredit,
  ExtractedFeature,
  ExtractedLine,
  FeatureCategory,
} from '@/extraction/schema';

// US Cellular is a regional MNO (primarily Midwest/Northwest) with its own
// plan family — it does not inherit from any other carrier. This normalizer
// canonicalizes the small set of recurring naming variants the LLM tends to
// trip on, and otherwise passes the bill through untouched. Heuristic plan
// canonicalization mirrors the verizon/att/tmobile modules.

const PLAN_CANONICAL: Array<{ pattern: RegExp; canonical: string }> = [
  {
    pattern: /^\s*business\s+unlimited\s+everyday\s*$/i,
    canonical: 'Business Unlimited Everyday',
  },
  {
    pattern: /^\s*business\s+unlimited\s+premium\s*$/i,
    canonical: 'Business Unlimited Premium',
  },
];

const FEATURE_CATEGORY_OVERRIDES: Array<{
  pattern: RegExp;
  category: FeatureCategory;
}> = [
  // "Device Protection+" is US Cellular's branded insurance add-on.
  { pattern: /device\s+protection\s*\+?/i, category: 'insurance' },
  // International calling add-on.
  { pattern: /international\s+connect/i, category: 'international' },
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
  if (trimmed === credit.name) return credit;
  return { ...credit, name: trimmed };
}
