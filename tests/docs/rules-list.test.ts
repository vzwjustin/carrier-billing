import { describe, expect, it } from 'vitest';

import { formatRulesForDocs } from '@/lib/docs/rules-list';
import { ALL_RULES } from '@/rules/registry';
import type { Rule } from '@/rules/types';

function fakeRule(partial: Pick<Rule, 'id' | 'title' | 'appliesTo'>): Rule {
  return {
    ...partial,
    evaluate: () => [],
  };
}

describe('formatRulesForDocs', () => {
  it('returns an empty array when given no rules', () => {
    expect(formatRulesForDocs([])).toEqual([]);
  });

  it('sorts mixed-carrier rules by id and preserves appliesTo', () => {
    const rules: Rule[] = [
      fakeRule({
        id: 'zeta_rule',
        title: 'Zeta',
        appliesTo: ['verizon', 'att'],
      }),
      fakeRule({
        id: 'alpha_rule',
        title: 'Alpha',
        appliesTo: 'all',
      }),
      fakeRule({
        id: 'beta_rule',
        title: 'Beta',
        appliesTo: ['tmobile'],
      }),
    ];

    const formatted = formatRulesForDocs(rules);

    expect(formatted.map((r) => r.id)).toEqual(['alpha_rule', 'beta_rule', 'zeta_rule']);
    expect(formatted[0]).toEqual({
      id: 'alpha_rule',
      title: 'Alpha',
      appliesTo: 'all',
    });
    expect(formatted[1]).toEqual({
      id: 'beta_rule',
      title: 'Beta',
      appliesTo: ['tmobile'],
    });
    expect(formatted[2]).toEqual({
      id: 'zeta_rule',
      title: 'Zeta',
      appliesTo: ['verizon', 'att'],
    });
  });

  it('shapes every registered rule and keeps a stable id-sorted order', () => {
    const formatted = formatRulesForDocs(ALL_RULES);

    expect(formatted).toHaveLength(ALL_RULES.length);

    const ids = formatted.map((r) => r.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);

    for (const entry of formatted) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.title).toBe('string');
      expect(entry.title.length).toBeGreaterThan(0);
      if (entry.appliesTo !== 'all') {
        expect(Array.isArray(entry.appliesTo)).toBe(true);
        expect(entry.appliesTo.length).toBeGreaterThan(0);
      }
    }
  });
});
