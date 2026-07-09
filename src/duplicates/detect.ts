import type {
  ExtractedAccount,
  ExtractedBill,
  ExtractedFeature,
  ExtractedLine,
} from '@/extraction/schema';
import type { Finding } from '@/rules/types';
import { formatCents } from '@/rules/helpers';

/**
 * Cross-entity duplicate detection.
 *
 * Looks across the entire audit for features billed twice — either on
 * different lines / the same line repeated within one account, or on
 * different accounts (BANs) within one bill. Splits results into two
 * severity buckets so the report UI can treat them differently:
 *
 *  - WITHIN-AUDIT (single account): high severity. Two charges with the
 *    same name + price billed on two lines in the same account (or the
 *    same line twice) is almost always a billing error — carriers don't
 *    legitimately stack identical SOCs on the same BAN.
 *
 *  - ACROSS-ACCOUNTS: medium severity. Same name + price spanning two
 *    BANs is a softer signal — two unrelated departments could legitimately
 *    carry an identically-named feature. Needs human review before we tell
 *    the customer to dispute.
 *
 * Pure function — no I/O, no dates, no LLM. Safe to call from a Rule.
 *
 * Indexes returned in `affected_line_indexes` are LOCAL to the first
 * affected account (per the rules-engine contract documented in
 * `src/rules/types.ts`). The persistence path translates them to global
 * line ids. `affected_account_indexes` carries every account a duplicate
 * group touched.
 */

const RULE_WITHIN = 'duplicate_charge_within_audit';
const RULE_ACROSS = 'duplicate_charge_across_accounts';

export const DUPLICATE_RULE_IDS = {
  within: RULE_WITHIN,
  across: RULE_ACROSS,
} as const;

/**
 * Input shape: explicit (features, lines, accounts) wiring so a future
 * caller can feed pre-loaded DB rows through this same detector without
 * pulling in the whole ExtractedBill type. The Rule wrappers under
 * `src/rules/definitions/` derive these views from `ctx.bill`.
 *
 * `features` carries enough provenance to point findings back at the
 * exact (account, line) that triggered the duplicate. Account-level
 * features don't exist in the current schema (only line-scoped features
 * + account-level credits), so every feature has a non-null lineIndex.
 */
export type DetectorFeatureRef = {
  accountIndex: number;
  lineIndex: number;
  feature: ExtractedFeature;
};

export type DetectorInput = {
  features: DetectorFeatureRef[];
  lines: ExtractedLine[][]; // lines[accountIndex][lineIndex]
  accounts: ExtractedAccount[];
};

/**
 * Build a DetectorInput from a full ExtractedBill. Convenience helper
 * for the Rule wrappers; tests exercise the underlying detector directly
 * via `detectCrossAuditDuplicates`.
 */
export function buildDetectorInput(bill: ExtractedBill): DetectorInput {
  const features: DetectorFeatureRef[] = [];
  const lines: ExtractedLine[][] = [];
  bill.accounts.forEach((account, accountIndex) => {
    const acctLines: ExtractedLine[] = [];
    account.lines.forEach((line, lineIndex) => {
      acctLines.push(line);
      for (const feature of line.features) {
        features.push({ accountIndex, lineIndex, feature });
      }
    });
    lines.push(acctLines);
  });
  return { features, lines, accounts: bill.accounts };
}

/**
 * Deterministic key for "same feature": lowercased + whitespace-normalized
 * name + exact monthly_charge_cents. Sub-cent equality is intentional —
 * a carrier double-billing the same SOC will print identical cents on
 * both rows. Different prices => different services in practice.
 */
function normalizeKey(name: string, monthlyCents: number): string {
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${cleaned}|${monthlyCents}`;
}

type Group = {
  key: string;
  name: string; // canonical display name from the first occurrence
  monthlyCents: number;
  refs: DetectorFeatureRef[];
};

function groupByKey(features: DetectorFeatureRef[]): Group[] {
  const buckets = new Map<string, Group>();
  for (const ref of features) {
    const key = normalizeKey(ref.feature.name, ref.feature.monthly_cents);
    const existing = buckets.get(key);
    if (existing) {
      existing.refs.push(ref);
    } else {
      buckets.set(key, {
        key,
        name: ref.feature.name,
        monthlyCents: ref.feature.monthly_cents,
        refs: [ref],
      });
    }
  }
  // Stable iteration order: insertion order from Map matches the
  // account-major / line-major / feature-major walk above. Snapshot tests
  // benefit from a deterministic order.
  return Array.from(buckets.values());
}

/**
 * Run the detector. Returns Finding[] in the standard rules-engine shape
 * (per-account-local line indexes; persistence layer translates them).
 *
 * A group with N occurrences (N ≥ 2) emits exactly ONE finding, with the
 * count in `evidence.occurrence_count`.
 *
 * Free features (monthly_cents === 0) are excluded — duplicating a $0
 * line item costs nothing and would noise up the report. This also
 * prevents a flurry of false positives from carriers that stamp a $0
 * "VZW Cloud included" placeholder on every line.
 */
export function detectCrossAuditDuplicates(input: DetectorInput): Finding[] {
  const findings: Finding[] = [];

  const eligible = input.features.filter((r) => r.feature.monthly_cents > 0);
  const groups = groupByKey(eligible);

  for (const group of groups) {
    if (group.refs.length < 2) continue;

    const accountIndexes = uniqueMapped(group.refs, (r) => r.accountIndex);
    const isAcrossAccounts = accountIndexes.length > 1;

    if (isAcrossAccounts) {
      findings.push(buildAcrossAccountsFinding(group, accountIndexes));
    } else {
      findings.push(buildWithinAuditFinding(group, accountIndexes));
    }
  }

  return findings;
}

// ⚡ Bolt: Single-pass unique mapping helper to avoid intermediate array instantiation from .map()
function uniqueMapped<T, U>(arr: T[], mapFn: (item: T) => U): U[] {
  const seen = new Set<U>();
  const out: U[] = [];
  for (const v of arr) {
    const mapped = mapFn(v);
    if (!seen.has(mapped)) {
      seen.add(mapped);
      out.push(mapped);
    }
  }
  return out;
}

function buildWithinAuditFinding(group: Group, accountIndexes: number[]): Finding {
  const accountIdx = accountIndexes[0];
  // Caller guarantees a single non-empty account bucket (group.refs.length >= 2,
  // accountIndexes.length === 1) before routing here. Assert rather than
  // silently defaulting to account 0 — a broken invariant must not mis-attribute
  // the finding to the wrong account.
  if (accountIdx === undefined) {
    throw new Error(
      '[duplicates] buildWithinAuditFinding: within-audit group has no account index',
    );
  }
  // All refs are in the same account; collect the local line indexes.
  // De-duplicate so "same line twice" doesn't double-stamp the same line id.
  const localLineIndexes = uniqueMapped(group.refs, (r) => r.lineIndex);
  const count = group.refs.length;
  // Conservative savings: keep one occurrence, recover the rest.
  const savings = group.monthlyCents * (count - 1);
  const sameLine = localLineIndexes.length === 1;
  const lineCountStr = sameLine
    ? 'the same line twice'
    : `${localLineIndexes.length} different lines`;

  return {
    rule_id: RULE_WITHIN,
    severity: 'high',
    title: `Duplicate "${group.name}" charge billed ${count}× within account`,
    description: `Found ${count} occurrences of "${group.name}" at ${formatCents(group.monthlyCents)}/mo on ${lineCountStr} in the same account. Identical SOC name + price within one BAN is almost always a billing error — carriers don't legitimately stack identical feature charges.`,
    recommended_action: `Dispute the duplicate "${group.name}" rows with the carrier and request a credit for any cycles already billed. Keep one instance active.`,
    estimated_monthly_savings_cents: savings,
    // High confidence: same BAN + identical name + identical price is
    // a structural signal carriers themselves treat as billing error.
    confidence: 0.9,
    affected_line_indexes: localLineIndexes,
    affected_account_indexes: [accountIdx],
    evidence: {
      feature_name: group.name,
      monthly_cents: group.monthlyCents,
      occurrence_count: count,
      same_line: sameLine,
      // Surface where the duplicates landed for human triage. Account
      // index is enough — no PII (no MDN/account number) is included.
      occurrences: group.refs.map((r) => ({
        account_index: r.accountIndex,
        line_index: r.lineIndex,
      })),
    },
  };
}

function buildAcrossAccountsFinding(group: Group, accountIndexes: number[]): Finding {
  const count = group.refs.length;
  // M1: a finding with line indexes alongside multiple account indexes
  // gets its line indexes wiped by translateLineIndexes (per its single-
  // account-per-finding invariant). Cross-account duplicates are about
  // the ACCOUNT pair, not the individual lines — surface affected
  // accounts only and leave line indexes empty so persistence doesn't
  // need to misroute UUIDs across accounts.
  const savings = group.monthlyCents * (count - 1);
  return {
    rule_id: RULE_ACROSS,
    severity: 'medium',
    title: `"${group.name}" billed on ${accountIndexes.length} different accounts`,
    description: `The feature "${group.name}" at ${formatCents(group.monthlyCents)}/mo appears ${count} times across ${accountIndexes.length} different accounts in this bill. Two BANs carrying an identically-named feature CAN be legitimate (different departments, identical SOC name) but warrants human review — if both accounts roll up to the same customer and the service is duplicated, it's recoverable.`,
    recommended_action: `Confirm with the carrier whether "${group.name}" represents the same underlying service across both accounts. If yes, request consolidation or a credit on the second instance.`,
    estimated_monthly_savings_cents: savings,
    // Medium confidence ("Likely" bucket): legitimate edge of two
    // unrelated services sharing a SOC name is non-trivial.
    confidence: 0.6,
    affected_line_indexes: [],
    affected_account_indexes: accountIndexes,
    evidence: {
      feature_name: group.name,
      monthly_cents: group.monthlyCents,
      occurrence_count: count,
      account_count: accountIndexes.length,
      occurrences: group.refs.map((r) => ({
        account_index: r.accountIndex,
        line_index: r.lineIndex,
      })),
    },
  };
}

/**
 * Test-only surface. `buildWithinAuditFinding` is internal, but its
 * account-index invariant — throw rather than silently default to account 0
 * when the account bucket is empty — is unreachable through the public
 * `detectCrossAuditDuplicates` API, which structurally never routes an empty
 * group here. Exposed so a test can exercise the guard directly. Mirrors the
 * `__testables` convention used by the webhook dispatchers.
 */
export const __testables = { buildWithinAuditFinding };
