import { describe, expect, it, vi } from 'vitest';
import type { Rule, RuleContext } from '@/rules/types';
import { runRules } from '@/rules/runner';
import {
  makeAccount,
  makeBill,
  makeCredit,
  makeDpp,
  makeFeature,
  makeLine,
  TEST_TODAY,
} from './fixtures';

// Stub Sentry so the runner doesn't try to ship anything during tests.
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

describe('runRules — full pipeline', () => {
  it('produces findings from a multi-rule fixture (snapshot)', async () => {
    const bill = makeBill({
      carrier: 'verizon',
      accounts: [
        makeAccount({
          // Triggers expired_promo_credit (high) and account_promo_expiring_soon
          // is suppressed for an already-expired credit.
          account_level_credits: [
            makeCredit({
              name: 'Loyalty Bonus',
              monthly_cents: -2500,
              expires_on: '2026-04-01',
            }),
          ],
          lines: [
            // Triggers suspended_line_billed (high) AND orphan_insurance (high).
            makeLine({
              mdn_last4: '1111',
              device: 'iPhone 14',
              is_suspended: true,
              plan_base_cents: 4500,
              features: [
                makeFeature({
                  name: 'Mobile Protect',
                  category: 'insurance',
                  monthly_cents: 1700,
                }),
              ],
            }),
            // Triggers completed_device_payment_still_billed.
            makeLine({
              mdn_last4: '2222',
              dpp_installments: [
                makeDpp({
                  device: 'iPhone 13',
                  monthly_cents: 2799,
                  remaining_payments: 0,
                  total_payments: 36,
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const ctx: RuleContext = { bill, today: TEST_TODAY, carrier: bill.carrier };
    const result = await runRules(ctx);

    expect(result.errors).toEqual([]);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);

    const summary = result.findings
      .map((f) => ({
        rule_id: f.rule_id,
        severity: f.severity,
        savings: f.estimated_monthly_savings_cents,
        title: f.title,
        confidence: f.confidence,
        evidence: f.evidence,
        affected_account_indexes: f.affected_account_indexes,
        affected_line_indexes: f.affected_line_indexes,
      }))
      .sort((a, b) => a.rule_id.localeCompare(b.rule_id));

    expect(summary).toMatchSnapshot();
  });

  it('scrubs PII from rule error messages before storing in errors[]', async () => {
    // Rule throws an error whose message contains a digit run (phone-like).
    // The errors[] entry must have the message scrubbed at source so any
    // downstream consumer (e.g. Sentry captureMessage extra.errors) cannot
    // ship raw PII even without relying on the beforeSend hook.
    const piiRule: Rule = {
      id: 'pii_rule',
      title: 'Throws with PII in message',
      appliesTo: 'all',
      evaluate: () => {
        // Use a digit string that HYPHEN_PHONE won't partially consume:
        // 8 isolated digits with no surrounding context that matches the
        // phone regex, so DIGIT_RUN fires and replaces the whole run.
        throw new Error('failed for account 56789012');
      },
    };

    const bill = makeBill();
    const ctx: RuleContext = { bill, today: TEST_TODAY, carrier: bill.carrier };
    const result = await runRules(ctx, [piiRule]);

    expect(result.errors).toHaveLength(1);
    const errMsg = result.errors[0]?.message ?? '';
    expect(errMsg).not.toContain('12345678901');
    expect(errMsg).toContain('[REDACTED]');
  });

  it('isolates failing rules — other rules still produce findings', async () => {
    const goodRule: Rule = {
      id: 'good_rule',
      title: 'Always fires',
      appliesTo: 'all',
      evaluate: () => [
        {
          rule_id: 'good_rule',
          severity: 'low',
          title: 'OK',
          description: 'OK',
          recommended_action: 'OK',
          estimated_monthly_savings_cents: 0,
          confidence: 1,
          affected_line_indexes: [],
          affected_account_indexes: [],
          evidence: {},
        },
      ],
    };

    const badRule: Rule = {
      id: 'bad_rule',
      title: 'Always throws',
      appliesTo: 'all',
      evaluate: () => {
        throw new Error('boom');
      },
    };

    const bill = makeBill();
    const ctx: RuleContext = { bill, today: TEST_TODAY, carrier: bill.carrier };
    const result = await runRules(ctx, [goodRule, badRule]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule_id).toBe('good_rule');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ rule_id: 'bad_rule', message: 'boom' });
  });

  it('skips rules that do not apply to the carrier', async () => {
    const verizonOnly: Rule = {
      id: 'verizon_only',
      title: 'Verizon only',
      appliesTo: ['verizon'],
      evaluate: () => [
        {
          rule_id: 'verizon_only',
          severity: 'info',
          title: 'V',
          description: 'V',
          recommended_action: 'V',
          estimated_monthly_savings_cents: 0,
          confidence: 1,
          affected_line_indexes: [],
          affected_account_indexes: [],
          evidence: {},
        },
      ],
    };

    const bill = makeBill({ carrier: 'att' });
    const ctx: RuleContext = { bill, today: TEST_TODAY, carrier: bill.carrier };
    const result = await runRules(ctx, [verizonOnly]);

    expect(result.findings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('clamps confidence into [0, 1]', async () => {
    const wildRule: Rule = {
      id: 'wild',
      title: 'wild',
      appliesTo: 'all',
      evaluate: () => [
        {
          rule_id: 'wild',
          severity: 'info',
          title: 't',
          description: 'd',
          recommended_action: 'a',
          estimated_monthly_savings_cents: 0,
          confidence: 5,
          affected_line_indexes: [],
          affected_account_indexes: [],
          evidence: {},
        },
        {
          rule_id: 'wild',
          severity: 'info',
          title: 't',
          description: 'd',
          recommended_action: 'a',
          estimated_monthly_savings_cents: 0,
          confidence: -2,
          affected_line_indexes: [],
          affected_account_indexes: [],
          evidence: {},
        },
      ],
    };

    const bill = makeBill();
    const ctx: RuleContext = { bill, today: TEST_TODAY, carrier: bill.carrier };
    const result = await runRules(ctx, [wildRule]);
    expect(result.findings.map((f) => f.confidence)).toEqual([1, 0]);
  });
});
