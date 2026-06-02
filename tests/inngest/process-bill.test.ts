import { describe, expect, it } from 'vitest';

import { dispatchAuditCompletedSideEffects } from '@/lib/audits/completed-side-effects';
import { processBillFn, __testables } from '@/inngest/functions/process-bill';
import { functions } from '@/inngest/functions';

describe('processBillFn', () => {
  it('is registered with the expected id', () => {
    const id = processBillFn.id();
    expect(id).toContain('process-bill');
  });

  it('exposes a stable name', () => {
    // The Inngest SDK exposes a `.name` getter on the function instance.
    // We don't pin the exact string, just that it's a non-empty string.
    expect(typeof processBillFn.name).toBe('string');
    expect(processBillFn.name.length).toBeGreaterThan(0);
  });

  it('is exported from the functions registry', () => {
    expect(functions).toContain(processBillFn);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (H6) mark-analyzing status guard
//
// Inngest invocation requires a harness this repo doesn't ship; the next-best
// guarantee against regressions is to pin the SQL filters the step issues.
// Specifically:
//
//   - The mark-analyzing UPDATE must filter `.eq('status', 'extracting')`
//     so that a delayed retry — say, one that lost the race against an
//     earlier successful run — does not stomp the row when it's already in
//     `analyzing`/`completed`.
//   - The step must `.select('id')` so we can read back the rows-affected
//     count, which is how we distinguish "race lost" from "broken".
//   - On a 0-rows-affected outcome the step must return without throwing
//     (a throw funnels into mark-failed and clobbers the terminal state),
//     so the source must contain the bail-out branch.
//
// We assert these by stringifying the function definition (via the Inngest
// SDK's getter on the underlying handler). String assertion is brittle, but
// it's strictly preferable to a regression that silently overwrites a
// completed audit's status. If you're refactoring this step, update the test
// to match — do not delete it without a discussion.
// ───────────────────────────────────────────────────────────────────────────

describe('processBillFn — H6 mark-analyzing status guard', () => {
  // The Inngest function exposes `.fn` as the user-supplied handler.
  // Stringifying it gives us the closure source to assert against.
  function getHandlerSource(): string {
    const fn = processBillFn as unknown as { fn?: unknown };
    if (typeof fn.fn === 'function') {
      return (fn.fn as () => unknown).toString();
    }
    // Fallback: stringify the entire object (older Inngest versions).
    return String(processBillFn);
  }

  it('mark-analyzing UPDATE chains .eq("status", "extracting")', () => {
    const src = getHandlerSource();
    // Find the mark-analyzing block and confirm the status filter is present.
    const idx = src.indexOf('mark-analyzing');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/\.eq\(['"]status['"]\s*,\s*['"]extracting['"]\)/);
  });

  it('mark-analyzing reads back the rows-affected count via .select("id")', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-analyzing');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/\.select\(['"]id['"]\)/);
  });

  it('mark-analyzing short-circuits on 0 rows affected (no throw)', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-analyzing');
    expect(idx).toBeGreaterThan(-1);
    // 6000-char window covers the schema-tolerance retry block plus the
    // post-update affected===0 bail. Bumped from 3000 after the retry
    // logic was added; the behavioural assertion is unchanged.
    const block = src.slice(idx, idx + 6000);
    // Must reference the status-guard reason and a return shape that the
    // outer fn collapses into a non-error skip.
    expect(block).toMatch(/status-guard/);
    // The bail must NOT throw inside the closure when affected===0.
    expect(block).toMatch(/affected\s*===?\s*0|affected\s*<\s*1/);
  });

  // (H7) mark-completed status guard — mirrors mark-analyzing assertions above.
  // Without a guard, a retried run overwrites aggregate columns and resets
  // completed_at. The update must be gated on .eq('status', 'analyzing') and
  // must bail (not throw) when 0 rows are affected.
  it('mark-completed UPDATE chains .eq("status", "analyzing")', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-completed');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/\.eq\(['"]status['"]\s*,\s*['"]analyzing['"]\)/);
  });

  it('mark-completed reads back rows-affected via .select("id")', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-completed');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/\.select\(['"]id['"]\)/);
  });

  it('mark-completed short-circuits on 0 rows affected (no throw)', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-completed');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/status-guard/);
    // The minified output uses the variable name from .select('id') ('rows' or
    // 'data'), so match the length===0 bail-out pattern generically.
    expect(block).toMatch(/\.length\s*===?\s*0/);
  });

  it('audit.completed Inngest send carries a stable idempotency key', () => {
    // (H5) The send must pass `id: \`${auditId}-completed\``
    // so a retried function cannot fire `audit.completed` twice.
    const src = dispatchAuditCompletedSideEffects.toString();
    expect(src).toMatch(/name:\s*['"]audit\.completed['"]/);
    expect(src).toMatch(/id:\s*`\$\{auditId\}-completed`/);
  });
});

describe('processBillFn — user-fault refund guard', () => {
  it('treats empty extraction as user fault (no credit refund)', () => {
    expect(__testables.isUserFaultFailure('no lines extracted')).toBe(true);
  });
});

describe('processBillFn — EDI811 routing sniff', () => {
  const edi = 'ISA*00*          *00*          *ZZ*VZW            *ZZ*ACME           *260401*1200*U*00401*000000001*0*P*:~';

  it('routes raw, BOM-prefixed, and whitespace-prefixed EDI buffers to EDI', () => {
    expect(__testables.isLikelyEdi811Buffer(Buffer.from(edi, 'utf8'))).toBe(true);
    expect(__testables.isLikelyEdi811Buffer(Buffer.from(`\uFEFF${edi}`, 'utf8'))).toBe(true);
    expect(__testables.isLikelyEdi811Buffer(Buffer.from(` \r\n\t${edi}`, 'utf8'))).toBe(true);
  });

  it('does not route PDFs or non-EDI text to EDI', () => {
    expect(__testables.isLikelyEdi811Buffer(Buffer.from('%PDF-1.7\n', 'utf8'))).toBe(false);
    expect(__testables.isLikelyEdi811Buffer(Buffer.from('ISAAC wrote a plain text upload', 'utf8'))).toBe(false);
    expect(__testables.isLikelyEdi811Buffer(Buffer.from('not even close to EDI', 'utf8'))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (C1) Inngest step-replay self-recognition
//
// If a step.run body commits its DB UPDATE but the worker dies before
// Inngest persists the step result, the retry re-executes the body. With
// `WHERE status='pending'`-style guards the retry observes the row already
// advanced and bails — stranding the audit in `extracting` or `analyzing`
// forever. The fix: each guard fetches `inngest_run_id` and, on a 0-rows-
// affected bail, recognizes its own run id and proceeds. Downstream steps
// either replay cached results or self-recognize via the same pattern.
//
// Mirroring the H6/H7 assertion style above: pin the substring of the
// closure source so a future refactor that removes the check fails loudly.
// ───────────────────────────────────────────────────────────────────────────

describe('processBillFn — C1 Inngest step-replay self-recognition', () => {
  function getHandlerSource(): string {
    const fn = processBillFn as unknown as { fn?: unknown };
    if (typeof fn.fn === 'function') {
      return (fn.fn as () => unknown).toString();
    }
    return String(processBillFn);
  }

  it('mark-extracting SELECT includes run identity fields', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-extracting');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2500);
    // The bail branch needs the run id to recognize self-replay and the
    // retry count to reject stale manual-retry generations.
    expect(block).toMatch(/['"]id, user_id, status, inngest_run_id, retry_count['"]/);
  });

  it('mark-extracting rejects stale manual-retry generations', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-extracting');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 3500);
    expect(block).toMatch(/row\.retry_count\s*!==?\s*retryCount/);
    expect(block).toMatch(/reason:\s*['"]stale-retry['"]/);
    expect(block).toMatch(/\.eq\(['"]retry_count['"]\s*,\s*retryCount\)/);
  });

  it('ownership-mismatch fail path reads back affected rows', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('ownership-mismatch');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 2500);
    expect(block).toMatch(/\.eq\(['"]status['"]\s*,\s*['"]pending['"]\)/);
    expect(block).toMatch(/\.eq\(['"]retry_count['"]\s*,\s*retryCount\)/);
    expect(block).toMatch(/\.select\(['"]id['"]\)/);
    expect(block).toMatch(/ownership-mismatch-race/);
  });

  it('mark-extracting bail branch checks inngest_run_id against event.id', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-extracting');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 4000);
    expect(block).toMatch(/inngest_run_id\s*===?\s*event\.id/);
    // Completed audits recover downstream side effects only — no re-extract.
    expect(block).toMatch(/row\.status\s*===?\s*['"]completed['"]/);
    expect(block).toMatch(/proceed:\s*['"]downstream-only['"]/);
    // Mid-pipeline replay (extracting/analyzing) still proceeds.
    expect(block).toMatch(/proceed:\s*true/);
  });

  it('mark-analyzing probes status + inngest_run_id on 0-rows-affected', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-analyzing');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 4000);
    // The follow-up probe must read both columns and the closure must
    // accept analyzing, extracting, OR completed as a self-replay terminal state.
    expect(block).toMatch(/['"]status, inngest_run_id['"]/);
    expect(block).toMatch(/inngest_run_id\s*===?\s*event\.id/);
    expect(block).toMatch(/probe\.status\s*===?\s*['"]extracting['"]/);
  });

  it('mark-analyzing is scoped to retry_count and this event run id', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-analyzing');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 5000);
    expect(block).toMatch(/\.eq\(['"]retry_count['"]\s*,\s*retryCount\)/);
    expect(block).toMatch(/\.eq\(['"]inngest_run_id['"]\s*,\s*event\.id\)/);
    expect(block).toMatch(/\.is\(['"]inngest_run_id['"]\s*,\s*null\)/);
  });

  it('mark-completed probes status + inngest_run_id on 0-rows-affected', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-completed');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 4000);
    expect(block).toMatch(/['"]status, inngest_run_id['"]/);
    expect(block).toMatch(/inngest_run_id\s*===?\s*event\.id/);
  });

  it('mark-completed and mark-failed are scoped to retry_count', () => {
    const src = getHandlerSource();
    const completedIdx = src.indexOf('mark-completed');
    expect(completedIdx).toBeGreaterThan(-1);
    const completedBlock = src.slice(completedIdx, completedIdx + 3000);
    expect(completedBlock).toMatch(/\.eq\(['"]retry_count['"]\s*,\s*retryCount\)/);

    const failedIdx = src.indexOf('mark-failed');
    expect(failedIdx).toBeGreaterThan(-1);
    const failedBlock = src.slice(failedIdx, failedIdx + 5000);
    expect(failedBlock).toMatch(/\.eq\(['"]retry_count['"]\s*,\s*retryCount\)/);
  });

  it('mark-failed refuses to fail a different Inngest run id', () => {
    const src = getHandlerSource();
    const idx = src.indexOf('mark-failed');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 6000);
    expect(block).toMatch(/['"]status, retry_count, inngest_run_id['"]/);
    expect(block).toMatch(/current\.inngest_run_id\s*===?\s*event\.id/);
    expect(block).toMatch(/\.eq\(['"]inngest_run_id['"]\s*,\s*event\.id\)/);
  });
});
