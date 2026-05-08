import * as Sentry from '@sentry/nextjs';
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

function ruleApplies(rule: Rule, ctx: RuleContext): boolean {
  if (rule.appliesTo === 'all') return true;
  return rule.appliesTo.includes(ctx.carrier);
}

function clampConfidence(c: number): number {
  if (Number.isNaN(c)) return 0;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

/**
 * Runs every applicable rule against the bill. A failing rule is captured
 * to Sentry and pushed onto the errors array — it never fails the audit.
 */
export async function runRules(
  ctx: RuleContext,
  rules: Rule[] = ALL_RULES,
): Promise<RunRulesResult> {
  const findings: Finding[] = [];
  const errors: RuleError[] = [];

  for (const rule of rules) {
    if (!ruleApplies(rule, ctx)) continue;
    try {
      const out = await rule.evaluate(ctx);
      for (const f of out) {
        findings.push({ ...f, confidence: clampConfidence(f.confidence) });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ rule_id: rule.id, message });
      Sentry.captureException(err, {
        tags: { rule_id: rule.id, carrier: ctx.carrier },
      });
    }
  }

  return { findings, errors };
}
