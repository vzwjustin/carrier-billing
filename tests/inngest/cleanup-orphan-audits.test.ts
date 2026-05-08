import { describe, expect, it } from 'vitest';

import { cleanupOrphanAuditsFn } from '@/inngest/functions/cleanup-orphan-audits';
import { functions } from '@/inngest/functions';

/**
 * Structural smoke tests for the cleanup-orphan-audits cron function.
 * Behavioral correctness (refund + status flip + status-guard race safety)
 * is exercised at the integration layer alongside the rest of the pipeline.
 */
describe('cleanupOrphanAuditsFn', () => {
  it('has id "cleanup-orphan-audits"', () => {
    const id = cleanupOrphanAuditsFn.id();
    expect(id).toContain('cleanup-orphan-audits');
  });

  it('is exported from the functions registry', () => {
    expect(functions).toContain(cleanupOrphanAuditsFn);
  });

  it('exposes a stable name', () => {
    expect(typeof cleanupOrphanAuditsFn.name).toBe('string');
    expect(cleanupOrphanAuditsFn.name.length).toBeGreaterThan(0);
  });
});
