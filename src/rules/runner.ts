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
        findings.push({
          ...f,
          confidence: clampConfidence(f.confidence, rule.id),
        });
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = scrubString(rawMessage);
      // Store the scrubbed message so callers (e.g. process-bill Sentry
      // captureMessage) never handle raw bill text from rule exceptions.
      errors.push({ rule_id: rule.id, message: safeMessage });
      // The original `err` may carry raw bill text in its message or in
      // any captured context — ship a sanitized clone to Sentry instead.
      const sanitized = new Error(safeMessage);
      sanitized.name = err instanceof Error ? err.name : 'RuleError';
      // H7: preserve the original stack trace. Constructing `new Error()`
      // here previously overwrote the throw-site frames, so every rule
      // exception in Sentry pointed at this line instead of the actual
      // rule that threw. Substitute the raw (PII-bearing) message with the
      // scrubbed one but keep the rest of the trace verbatim.
      if (err instanceof Error && typeof err.stack === 'string') {
        sanitized.stack = err.stack.replace(rawMessage, safeMessage);
      }
      Sentry.captureException(sanitized, {
        tags: { rule_id: rule.id, carrier: ctx.carrier },
      });
    }
  }

  return { findings, errors };
}
