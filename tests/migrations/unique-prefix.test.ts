import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * #7 — Guard against duplicate migration version prefixes.
 *
 * The Supabase CLI derives `schema_migrations.version` from the leading numeric
 * token of a migration filename. Two files sharing a prefix collide on that
 * version key, so `supabase db push` can record/skip only one per version —
 * silently leaving a sibling unapplied on a partial / incremental environment
 * (e.g. one that applied only one of a 0019_* pair).
 *
 * GRANDFATHERED: the prefixes below are already duplicated in shipped, applied
 * migrations. Renumbering them requires a coordinated `supabase migration
 * repair` across every environment, so they are allow-listed here and tracked
 * for deliberate cleanup. DO NOT extend this list — give every new migration a
 * unique, monotonic prefix.
 */
const GRANDFATHERED_DUPLICATE_PREFIXES = new Set(['0019', '0020']);

describe('supabase migration filenames', () => {
  it('have unique numeric prefixes (except grandfathered)', () => {
    const dir = join(process.cwd(), 'supabase', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

    const byPrefix = new Map<string, string[]>();
    for (const file of files) {
      const match = /^(\d+)/.exec(file);
      const prefix = match?.[1];
      if (!prefix) continue;
      const list = byPrefix.get(prefix) ?? [];
      list.push(file);
      byPrefix.set(prefix, list);
    }

    const offenders = [...byPrefix.entries()]
      .filter(([prefix, list]) => list.length > 1 && !GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix))
      .map(([prefix, list]) => `${prefix}: ${list.join(', ')}`);

    expect(
      offenders,
      `duplicate migration numeric prefixes found (give each a unique prefix):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
