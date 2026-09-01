import * as Sentry from '@sentry/nextjs';
import { scrubString } from '@/lib/observability/redact';
import type { Finding, Rule, RuleContext } from './types';
import { ALL_RULES } from './registry';

export type RuleError = {
  rule_id: string;
  message: string;
};

export type RunRulesResult = {
  findings: Finding[];
  errors: RuleError[];
};

type ArbitrationRule = {
  dominantRuleId: string;
  suppressedRuleIds: readonly string[];
};

const SAVINGS_ARBITRATION_RULES: readonly ArbitrationRule[] = [
  {
    dominantRuleId: 'zero_usage_phone_line',
    suppressedRuleIds: ['high_cost_low_usage_phone', 'underutilized_phone_on_premium_plan'],
  },
  {
    dominantRuleId: 'insurance_after_device_payoff',
    suppressedRuleIds: ['duplicate_protection_features'],
  },
  // M4: the feature-only-zombie branch of orphan_insurance (plan_base 0/null,
  // not suspended, not BYOD) can co-fire with insurance_after_device_payoff on
  // a line with a paid-off DPP + insurance — both emit the full insurance total
  // as savings, double-counting one recoverable removal ($30 claimed vs $15
  // real). orphan_insurance is the higher-level "this whole line is dead"
  // finding, so it dominates.
  {
    dominantRuleId: 'orphan_insurance',
    suppressedRuleIds: ['insurance_after_device_payoff'],
  },
  // F4: high_cost_low_usage_phone and underutilized_phone_on_premium_plan can
  // both fire on the SAME premium low-usage line, summing two savings estimates
  // for one downgrade action ($20 + $10 = $30 for what is a single change).
  // The higher-dollar, tighter-criteria rule dominates — same posture as the
  // zero_usage entries above. (Arbitration is per-line via affectedLineKeys, so
  // genuinely separate lines that each trip only one of the two are untouched.)
  {
    dominantRuleId: 'high_cost_low_usage_phone',
    suppressedRuleIds: ['underutilized_phone_on_premium_plan'],
  },
] as const;

function ruleApplies(rule: Rule, ctx: RuleContext): boolean {
  if (rule.appliesTo === 'all') return true;
  return rule.appliesTo.includes(ctx.carrier);
}

function clampConfidence(c: number, ruleId: string): number {
  const outOfRange = Number.isNaN(c) || c < 0 || c > 1;
  if (outOfRange && process.env.NODE_ENV === 'development') {
    // Dev-only: surface rule authoring bugs (e.g. forgetting to keep a
    // confidence multiplier in [0,1]) without spamming production logs.

    console.warn('[rules] confidence out of range', { c, ruleId });
  }
  if (Number.isNaN(c)) return 0;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

function affectedLineKeys(finding: Finding): string[] {
  const keys: string[] = [];
  for (const accountIndex of finding.affected_account_indexes) {
    for (const lineIndex of finding.affected_line_indexes) {
      keys.push(`${accountIndex}:${lineIndex}`);
    }
  }
  return keys;
}

function arbitrateOverlappingSavings(findings: Finding[]): Finding[] {
  const protectedKeysByRuleId = new Map<string, Set<string>>();
  for (const rule of SAVINGS_ARBITRATION_RULES) {
    protectedKeysByRuleId.set(rule.dominantRuleId, new Set());
  }

  for (const finding of findings) {
    const protectedKeys = protectedKeysByRuleId.get(finding.rule_id);
    if (protectedKeys === undefined) continue;
    for (const key of affectedLineKeys(finding)) {
      protectedKeys.add(key);
    }
  }

  return findings.filter((finding) => {
    const findingKeys = affectedLineKeys(finding);
    if (findingKeys.length === 0) return true;

    for (const rule of SAVINGS_ARBITRATION_RULES) {
      if (!rule.suppressedRuleIds.includes(finding.rule_id)) continue;
      const protectedKeys = protectedKeysByRuleId.get(rule.dominantRuleId);
      if (protectedKeys === undefined) continue;
      if (findingKeys.some((key) => protectedKeys.has(key))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Runs every applicable rule against the bill. A failing rule is captured
 * to Sentry and pushed onto the errors array — it never fails the audit.
 * Savings arbitration happens after all rule outputs are collected so rules
 * remain independent while downstream totals avoid double-counting overlapping
 * charge surfaces on the same account line.
 */
export async function runRules(
  ctx: RuleContext,
  rules: Rule[] = ALL_RULES,
): Promise<RunRulesResult> {
  const findings: Finding[] = [];
  const errors: RuleError[] = [];

  // ⚡ Bolt: Execute rules concurrently using Promise.all to improve throughput while preserving order
  const ruleResults = await Promise.all(
    rules.map(async (rule) => {
      if (!ruleApplies(rule, ctx)) return { findings: [], errors: [] };
      const localFindings: Finding[] = [];
      const localErrors: RuleError[] = [];
      try {
        const out = await rule.evaluate(ctx);
        for (const f of out) {
          localFindings.push({
            ...f,
            confidence: clampConfidence(f.confidence, rule.id),
          });
        }
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const safeMessage = scrubString(rawMessage);
        localErrors.push({ rule_id: rule.id, message: safeMessage });
        const sanitized = new Error(safeMessage);
        sanitized.name = err instanceof Error ? err.name : 'RuleError';
        if (err instanceof Error && typeof err.stack === 'string') {
          sanitized.stack = err.stack.replace(rawMessage, safeMessage);
        }
        Sentry.captureException(sanitized, {
          tags: { rule_id: rule.id, carrier: ctx.carrier },
        });
      }
      return { findings: localFindings, errors: localErrors };
    })
  );

  for (const res of ruleResults) {
    findings.push(...res.findings);
    errors.push(...res.errors);
  }

  return { findings: arbitrateOverlappingSavings(findings), errors };
}
