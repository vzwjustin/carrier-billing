import { describe, expect, it } from 'vitest';
import type { Rule } from '@/rules/types';
import { ALL_RULES, validateRegistry } from '@/rules/registry';

function makeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'test_rule',
    title: 'Test rule',
    appliesTo: 'all',
    evaluate: () => [],
    ...over,
  };
}

describe('rules/registry self-check', () => {
  it('ALL_RULES passes validation (the module-load assertion is satisfied)', () => {
    expect(() => validateRegistry(ALL_RULES)).not.toThrow();
  });

  it('every rule in ALL_RULES has a unique id', () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every rule in ALL_RULES has a non-empty title', () => {
    for (const r of ALL_RULES) {
      expect(r.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('throws on duplicate rule ids', () => {
    const a = makeRule({ id: 'dupe' });
    const b = makeRule({ id: 'dupe' });
    expect(() => validateRegistry([a, b])).toThrow(/duplicate rule id "dupe"/);
  });

  it('throws on empty rule id', () => {
    const bad = makeRule({ id: '' });
    expect(() => validateRegistry([bad])).toThrow(/empty id/);
  });

  it('throws on empty rule title', () => {
    const bad = makeRule({ id: 'ok', title: '   ' });
    expect(() => validateRegistry([bad])).toThrow(/empty title/);
  });

  it('throws on unknown carrier in appliesTo', () => {
    const bad = makeRule({
      id: 'bad_carrier',
      // @ts-expect-error — testing the runtime guard against a bad carrier
      appliesTo: ['martian'],
    });
    expect(() => validateRegistry([bad])).toThrow(/unknown carrier "martian"/);
  });

  it('throws on empty appliesTo array (must use "all" instead)', () => {
    const bad = makeRule({ id: 'empty_applies', appliesTo: [] });
    expect(() => validateRegistry([bad])).toThrow(/empty array/);
  });

  it('throws when a rule has no evaluate function', () => {
    const bad = makeRule({ id: 'no_evaluate' });
    // Cast to Partial<Rule> makes `evaluate` optional so `delete` is legal —
    // simulating a malformed rule that slipped past the compile-time type.
    delete (bad as Partial<Rule>).evaluate;
    expect(() => validateRegistry([bad])).toThrow(
      /rule "no_evaluate" has no evaluate function/,
    );
  });

  it('accepts a valid carrier-scoped rule', () => {
    const ok = makeRule({ id: 'verizon_only', appliesTo: ['verizon'] });
    expect(() => validateRegistry([ok])).not.toThrow();
  });
});
