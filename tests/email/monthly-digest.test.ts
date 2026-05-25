import { describe, expect, it } from 'vitest';

import {
  buildMonthlyDigest,
  clampLast4,
  escapeHtml,
  formatCents,
  formatSignedCents,
  renderMonthlyDigestText,
} from '@/email/monthly-digest';
import type { MonthlyDigestProps } from '@/email/monthly-digest';

const BASE_PROPS: MonthlyDigestProps = {
  periodLabel: 'May 2026',
  totalSpendCents: 248_75_00 / 100, // mistake guard — pass a real cents number below
  autopsy: null,
  openFindingsBySeverity: { high: 2, medium: 4, low: 1 },
  totalRecoverableSavingsCents: 9_750, // $97.50
  topUnusedLines: [],
  dashboardUrl: 'https://app.example.com',
  unsubscribeUrl: 'https://app.example.com/api/email/unsubscribe?token=tok123',
};

// Use a clean numeric value for spend rather than the obfuscated one above.
const PROPS: MonthlyDigestProps = {
  ...BASE_PROPS,
  totalSpendCents: 248_75, // $248.75 expressed as cents
};

describe('formatCents / formatSignedCents', () => {
  it('formatCents renders standard USD', () => {
    expect(formatCents(123_45)).toBe('$123.45');
    expect(formatCents(0)).toBe('$0.00');
  });

  it('formatSignedCents prefixes a sign for non-zero values', () => {
    expect(formatSignedCents(100)).toBe('+$1.00');
    expect(formatSignedCents(-100)).toBe('-$1.00');
    expect(formatSignedCents(0)).toBe('$0.00');
  });
});

describe('escapeHtml', () => {
  it('escapes the OWASP basics', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it("escapes ampersand and single-quote", () => {
    expect(escapeHtml(`A&B's`)).toBe('A&amp;B&#39;s');
  });
});

describe('clampLast4', () => {
  it('returns the last 4 digits of any masked input', () => {
    expect(clampLast4('5551234')).toBe('1234');
    expect(clampLast4('1234')).toBe('1234');
    expect(clampLast4('***1234')).toBe('1234');
  });

  it('replaces non-strings and empty values with dots', () => {
    expect(clampLast4(null)).toBe('••••');
    expect(clampLast4('')).toBe('••••');
    expect(clampLast4('letters')).toBe('••••');
  });
});

describe('buildMonthlyDigest — subject', () => {
  it('mentions the period and the recoverable amount', () => {
    const { subject } = buildMonthlyDigest(PROPS);
    expect(subject).toContain('May 2026');
    expect(subject).toContain('$97.50');
    expect(subject).toContain('CarrierAudit');
  });
});

describe('buildMonthlyDigest — plain text body', () => {
  it('renders the header, totals, finding counts, dashboard + unsub URLs', () => {
    const text = renderMonthlyDigestText(PROPS);
    expect(text).toContain('May 2026 digest');
    expect(text).toContain('$248.75');
    expect(text).toContain('2 high · 4 medium · 1 low');
    expect(text).toContain('$97.50/mo');
    expect(text).toContain('https://app.example.com');
    expect(text).toContain(
      'https://app.example.com/api/email/unsubscribe?token=tok123',
    );
  });

  it('renders the autopsy block when present, suppresses it otherwise', () => {
    const without = renderMonthlyDigestText(PROPS);
    expect(without).toContain('not enough history yet');

    const withAutopsy = renderMonthlyDigestText({
      ...PROPS,
      autopsy: {
        netChangeCents: 4_523,
        disputableCents: 1_200,
        optimizationCents: 800,
      },
    });
    expect(withAutopsy).toContain('+$45.23');
    expect(withAutopsy).toContain('Disputable: $12.00');
    expect(withAutopsy).toContain('Optimization: $8.00');
  });

  it('renders top unused lines with labels, last-4 MDN, and per-line savings', () => {
    const text = renderMonthlyDigestText({
      ...PROPS,
      topUnusedLines: [
        {
          label: "Justin's iPad",
          mdnMaskedLast4: '5551234',
          ruleId: 'zero_usage_phone_line',
          estimatedMonthlySavingsCents: 4_000,
        },
        {
          label: null,
          mdnMaskedLast4: '0001',
          ruleId: 'unused_mifi_or_jetpack_line',
          estimatedMonthlySavingsCents: 2_500,
        },
      ],
    });
    expect(text).toContain('Top unused lines:');
    expect(text).toContain("Justin's iPad (…1234)");
    expect(text).toContain('Zero usage: $40.00/mo');
    expect(text).toContain('Line (…0001)');
    expect(text).toContain('Unused hotspot: $25.00/mo');
  });

  it('caps top unused lines to 3 even if more are passed', () => {
    const text = renderMonthlyDigestText({
      ...PROPS,
      topUnusedLines: Array.from({ length: 5 }, (_, i) => ({
        label: `Line ${i + 1}`,
        mdnMaskedLast4: `000${i}`,
        ruleId: 'zero_usage_phone_line',
        estimatedMonthlySavingsCents: 1_000 * (i + 1),
      })),
    });
    expect(text).toContain('Line 1');
    expect(text).toContain('Line 2');
    expect(text).toContain('Line 3');
    expect(text).not.toContain('Line 4');
    expect(text).not.toContain('Line 5');
  });
});

describe('buildMonthlyDigest — HTML body', () => {
  it('escapes user-supplied label strings to prevent HTML injection', () => {
    const { html } = buildMonthlyDigest({
      ...PROPS,
      topUnusedLines: [
        {
          label: '<script>alert("xss")</script>',
          mdnMaskedLast4: '1234',
          ruleId: 'zero_usage_phone_line',
          estimatedMonthlySavingsCents: 1_000,
        },
      ],
    });
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('escapes the periodLabel and includes dashboard / unsub anchors', () => {
    const { html } = buildMonthlyDigest({
      ...PROPS,
      periodLabel: 'May & June 2026',
    });
    expect(html).toContain('May &amp; June 2026');
    expect(html).toContain('href="https://app.example.com"');
    expect(html).toContain(
      'href="https://app.example.com/api/email/unsubscribe?token=tok123"',
    );
  });

  it('renders accent CSS for the recoverable savings amount', () => {
    const { html } = buildMonthlyDigest(PROPS);
    expect(html).toContain('$97.50/mo');
    expect(html).toMatch(/color:#0f766e/);
  });

  it('uses a <!doctype html> document and includes the noindex robots equivalent only outside (Resend does not need meta robots)', () => {
    const { html } = buildMonthlyDigest(PROPS);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Sanity: the rendered HTML is a single string (no React tree leaked).
    expect(typeof html).toBe('string');
  });
});

describe('buildMonthlyDigest — PII discipline', () => {
  it('truncates over-long mdnMasked to last 4 digits in HTML and text', () => {
    const { html, text } = buildMonthlyDigest({
      ...PROPS,
      topUnusedLines: [
        {
          label: 'Line',
          mdnMaskedLast4: '15551239876',
          ruleId: 'zero_usage_phone_line',
          estimatedMonthlySavingsCents: 1_000,
        },
      ],
    });
    expect(text).toContain('(…9876)');
    expect(html).toContain('…9876');
    // Crucially: the leading digits MUST NOT appear in the output.
    expect(text).not.toContain('15551239876');
    expect(html).not.toContain('15551239876');
  });
});
