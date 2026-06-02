/**
 * Tests for the OnboardingChecklist's pure state helper.
 *
 * We test `computeChecklistState` directly rather than rendering the server
 * component — wiring up a Supabase mock for the join through `audits` adds
 * a lot of plumbing for limited coverage. The component itself is a thin
 * presentation layer over the helper's output.
 */
import { describe, expect, it, vi } from 'vitest';

// The component module statically imports `@/lib/supabase/server`, which
// in turn pulls in `next/headers` — not available under Vitest's JSDOM
// runtime. We only exercise the pure helper, so a no-op mock is enough
// to let the module load.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { computeChecklistState } from '@/components/dashboard/onboarding-checklist';

describe('computeChecklistState', () => {
  it('renders all five items, all incomplete, for a brand-new user', () => {
    const result = computeChecklistState({
      hasAudits: false,
      hasCostCenter: false,
      hasContract: false,
    });

    expect(result.shouldRender).toBe(true);
    expect(result.items).toHaveLength(5);
    expect(result.items.map((i) => i.done)).toEqual([false, false, false, false, false]);
    // Cost-center step is disabled until the user has at least one audit.
    expect(result.items[2]?.disabled).toBe(true);
    // PDF, CSV, contract, assistant should be actionable.
    expect(result.items[0]?.disabled).toBe(false);
    expect(result.items[1]?.disabled).toBe(false);
    expect(result.items[3]?.disabled).toBe(false);
    expect(result.items[4]?.disabled).toBe(false);
  });

  it('marks PDF + CSV steps done once any audit exists', () => {
    const result = computeChecklistState({
      hasAudits: true,
      hasCostCenter: false,
      hasContract: false,
    });

    expect(result.shouldRender).toBe(true);
    // Steps 1 and 2 share the "has any audit" signal.
    expect(result.items[0]?.done).toBe(true);
    expect(result.items[1]?.done).toBe(true);
    // Cost-center is now actionable (no longer disabled).
    expect(result.items[2]?.disabled).toBe(false);
    expect(result.items[2]?.done).toBe(false);
  });

  it('marks the cost-center step done independently', () => {
    const result = computeChecklistState({
      hasAudits: true,
      hasCostCenter: true,
      hasContract: false,
    });

    expect(result.items[2]?.done).toBe(true);
    expect(result.shouldRender).toBe(true);
  });

  it('marks the contract step done independently', () => {
    const result = computeChecklistState({
      hasAudits: false,
      hasCostCenter: false,
      hasContract: true,
    });

    expect(result.items[3]?.done).toBe(true);
    // Still renders because audits + cost-center are incomplete.
    expect(result.shouldRender).toBe(true);
  });

  it('hides the checklist once every detectable step is complete', () => {
    const result = computeChecklistState({
      hasAudits: true,
      hasCostCenter: true,
      hasContract: true,
    });

    expect(result.shouldRender).toBe(false);
  });

  it('keeps the assistant step always-actionable (never green-checked)', () => {
    const result = computeChecklistState({
      hasAudits: true,
      hasCostCenter: true,
      hasContract: true,
    });

    const assistant = result.items[4];
    expect(assistant?.alwaysActionable).toBe(true);
    expect(assistant?.done).toBe(false);
    expect(assistant?.disabled).toBe(false);
    // Even when shouldRender is false above, the assistant item still has
    // the right shape — the assistant signal is intentionally unobservable.
  });

  it('points each step at the documented href', () => {
    const result = computeChecklistState({
      hasAudits: false,
      hasCostCenter: false,
      hasContract: false,
    });

    expect(result.items[0]?.href).toBe('/audits/new');
    expect(result.items[1]?.href).toBe('/audits/new/import-csv');
    expect(result.items[2]?.href).toBe('/audits');
    expect(result.items[3]?.href).toBe('/contracts/new');
    expect(result.items[4]?.href).toBe('/assistant');
  });
});
