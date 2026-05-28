/**
 * Pure helper used by the `/docs/rules` page. Shapes the rule registry into a
 * stable, display-friendly array sorted by id so the docs render
 * deterministically at build time.
 *
 * No I/O — feeds entirely off the `Rule[]` it's handed. The page passes in
 * `ALL_RULES` from `@/rules/registry`; tests pass synthetic rules.
 */
import type { Carrier } from '@/extraction/schema';
import type { Rule } from '@/rules/types';

export interface DocsRuleEntry {
  id: string;
  title: string;
  /**
   * Either the literal string `'all'` (rule runs on every carrier) or the
   * carrier list copied from the rule definition. We never widen `'all'`
   * to the full carrier enum here — preserving the original intent keeps
   * the docs honest if a new carrier is added later.
   */
  appliesTo: 'all' | Carrier[];
}

export function formatRulesForDocs(rules: Rule[]): DocsRuleEntry[] {
  return rules
    .map<DocsRuleEntry>((rule) => ({
      id: rule.id,
      title: rule.title,
      appliesTo: rule.appliesTo === 'all' ? 'all' : [...rule.appliesTo],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
