import type { ExtractedBill } from '@/extraction/schema';
import type { Finding } from '@/rules/types';

/**
 * Logger surface required by translateLineIndexes. Matches the subset of
 * Inngest's `logger` we actually use, so tests can pass a plain object.
 */
type IndexTranslationLogger = {
  warn: (message: string, ctx?: Record<string, unknown>) => void;
};

export type IndexTranslationOptions = {
  auditId: string;
  warn: IndexTranslationLogger['warn'];
};

export type IndexTranslationStats = {
  /** Number of (finding, localIdx) pairs dropped because the local index was
   *  outside the account's line range. Each drop also emits a warn log. */
  droppedLineIndexes: number;
  /** Number of findings whose entire affected_line_indexes array was wiped
   *  due to a bad account index. Distinct from droppedLineIndexes. */
  findingsWithDroppedAccount: number;
};

/**
 * Translate each finding's `affected_line_indexes` from per-account-local
 * positions (what every rule under `src/rules/definitions` emits) to
 * globally-flat positions inside `bill.accounts.flatMap(a => a.lines)`.
 */
export function translateLineIndexes(
  findings: Finding[],
  bill: ExtractedBill,
  opts: IndexTranslationOptions,
  stats?: IndexTranslationStats,
): Finding[] {
  const accountLineCounts = bill.accounts.map((a) => a.lines.length);
  const accountStartOffsets: number[] = [];
  let running = 0;
  for (const n of accountLineCounts) {
    accountStartOffsets.push(running);
    running += n;
  }
  const totalLineCount = running;

  return findings.map((f) => {
    if (f.affected_line_indexes.length === 0) {
      return f;
    }
    if (f.affected_account_indexes.length > 1) {
      opts.warn(
        'translateLineIndexes: finding has line indexes spanning multiple accounts — dropping line indexes',
        {
          auditId: opts.auditId,
          rule_id: f.rule_id,
          accountIndexes: f.affected_account_indexes,
        },
      );
      if (stats) stats.findingsWithDroppedAccount += 1;
      return {
        ...f,
        affected_line_indexes: [],
      };
    }
    const accountIdx = f.affected_account_indexes[0];
    if (typeof accountIdx !== 'number') {
      opts.warn(
        'translateLineIndexes: finding has line indexes but no account index — dropping line indexes',
        { auditId: opts.auditId, rule_id: f.rule_id },
      );
      if (stats) stats.findingsWithDroppedAccount += 1;
      return { ...f, affected_line_indexes: [] };
    }
    if (accountIdx < 0 || accountIdx >= accountLineCounts.length) {
      opts.warn(
        'translateLineIndexes: finding affected_account_indexes[0] out of range — dropping line indexes',
        {
          auditId: opts.auditId,
          rule_id: f.rule_id,
          accountIdx,
          accountCount: accountLineCounts.length,
        },
      );
      if (stats) stats.findingsWithDroppedAccount += 1;
      return {
        ...f,
        affected_line_indexes: [],
        affected_account_indexes: [],
      };
    }
    const accountSize = accountLineCounts[accountIdx] ?? 0;
    const offset = accountStartOffsets[accountIdx] ?? 0;
    const globalIndexes: number[] = [];
    for (const localIdx of f.affected_line_indexes) {
      if (
        typeof localIdx !== 'number' ||
        localIdx < 0 ||
        localIdx >= accountSize
      ) {
        opts.warn(
          'translateLineIndexes: finding has out-of-range per-account line index — dropping that index only',
          {
            auditId: opts.auditId,
            rule_id: f.rule_id,
            accountIdx,
            localIdx,
            accountSize,
          },
        );
        if (stats) stats.droppedLineIndexes += 1;
        continue;
      }
      const globalIdx = offset + localIdx;
      if (globalIdx >= totalLineCount) {
        continue;
      }
      globalIndexes.push(globalIdx);
    }
    return { ...f, affected_line_indexes: globalIndexes };
  });
}
