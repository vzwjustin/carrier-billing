import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

/**
 * Onboarding checklist — replaces the generic "Welcome" hero for users with
 * 0 audits and re-renders until the user has touched the major surfaces of
 * the product (CSV/PDF upload, cost-center tagging, contracts, assistant).
 *
 * Server component: fetches counts via three lightweight queries that all
 * scope through RLS. Renders nothing once every detectable step is complete
 * so power users don't get a stale checklist on their dashboard.
 *
 * Detection nuances:
 *  - Steps 1 & 2 (PDF / CSV upload) share a single signal — any audit row
 *    counts. The spec is fine with this: it's a "first audit produced"
 *    milestone, not a "tried both upload paths" milestone.
 *  - Step 3 (cost-center tagging) requires a join through `audits.user_id`
 *    because `bill_lines` is owner-scoped via that FK. We do it via a
 *    `select('audit_id, audits!inner(user_id)')` with `cost_center` filter.
 *  - Step 5 (assistant) is non-detectable without a new table, so it's
 *    always rendered as actionable. SPEC discipline: no migrations here.
 */

export interface ChecklistState {
  hasAudits: boolean;
  hasCostCenter: boolean;
  hasContract: boolean;
}

export interface ChecklistItemState {
  number: number;
  label: string;
  why: string;
  cta: string;
  href: string;
  done: boolean;
  /** disabled items can't be clicked yet (gated on a prior step) */
  disabled: boolean;
  /** assistant step has no green-check signal even if "done" */
  alwaysActionable?: boolean;
}

/**
 * Pure helper — easy to unit-test without standing up Supabase mocks.
 * Returns the item list + whether the checklist should render at all.
 *
 * "Should render" rule: hide when every *detectable* step is complete.
 * The assistant step doesn't count toward this since we can't detect it.
 */
export function computeChecklistState(state: ChecklistState): {
  items: ChecklistItemState[];
  shouldRender: boolean;
  mostRecentAuditHref: string;
} {
  const mostRecentAuditHref = '/audits';

  const items: ChecklistItemState[] = [
    {
      number: 1,
      label: 'Upload your first wireless bill PDF',
      why: 'We extract every line, plan, credit, and feature in under 5 minutes.',
      cta: 'Upload PDF',
      href: '/audits/new',
      done: state.hasAudits,
      disabled: false,
    },
    {
      number: 2,
      label: 'Or upload a CSV export instead',
      why: 'Already pulled a line-item export from your carrier portal? Skip the PDF.',
      cta: 'Import CSV',
      href: '/audits/new/import-csv',
      done: state.hasAudits,
      disabled: false,
    },
    {
      number: 3,
      label: 'Tag your lines with cost centers',
      why: 'Roll spend up by team or department for chargeback and forecasting.',
      cta: state.hasAudits ? 'Tag lines' : 'Upload a bill first',
      href: mostRecentAuditHref,
      done: state.hasCostCenter,
      disabled: !state.hasAudits,
    },
    {
      number: 4,
      label: 'Upload a carrier contract',
      why: 'We compare your billed rates to your contracted rates and flag drift.',
      cta: 'Add contract',
      href: '/contracts/new',
      done: state.hasContract,
      disabled: false,
    },
    {
      number: 5,
      label: 'Ask the AI assistant a question',
      why: 'Ask "which lines should I cancel?" — the assistant cites your bill.',
      cta: 'Open assistant',
      href: '/assistant',
      done: false,
      disabled: false,
      alwaysActionable: true,
    },
  ];

  // Detectable steps = 1+2 (audits), 3 (cost center), 4 (contract). Step 5 is
  // always actionable and never counts. We hide the checklist when each of
  // those is done.
  const shouldRender = !(state.hasAudits && state.hasCostCenter && state.hasContract);

  return { items, shouldRender, mostRecentAuditHref };
}

interface BillLineJoinRow {
  audit_id: string;
  audits: { user_id: string } | { user_id: string }[] | null;
}

/**
 * Load all three signals concurrently. RLS already scopes `audits` and
 * `contracts` to the current user, so we use HEAD count queries. The
 * cost-center signal requires a join through `audits` (since `bill_lines`
 * doesn't carry `user_id`). We use `!inner` to enforce the join and
 * `cost_center` filter to limit to relevant rows; LIMIT 1 keeps it cheap.
 */
async function loadChecklistState(userId: string): Promise<ChecklistState> {
  const supabase = await createClient();

  const [auditsRes, contractsRes, costCenterRes] = await Promise.all([
    supabase.from('audits').select('id', { head: true, count: 'exact' }),
    supabase.from('contracts').select('id', { head: true, count: 'exact' }),
    supabase
      .from('bill_lines')
      .select('audit_id, audits!inner(user_id)')
      .not('cost_center', 'is', null)
      .eq('audits.user_id', userId)
      .limit(1)
      .returns<BillLineJoinRow[]>(),
  ]);

  const hasAudits = (auditsRes.count ?? 0) > 0;
  const hasContract = (contractsRes.count ?? 0) > 0;
  const hasCostCenter = (costCenterRes.data ?? []).length > 0;

  return { hasAudits, hasCostCenter, hasContract };
}

export interface OnboardingChecklistProps {
  userId: string;
}

export async function OnboardingChecklist({
  userId,
}: OnboardingChecklistProps): Promise<React.JSX.Element | null> {
  const state = await loadChecklistState(userId);
  const { items, shouldRender } = computeChecklistState(state);

  if (!shouldRender) return null;

  return (
    <section
      aria-label="Onboarding checklist"
      className="rounded-lg border border-neutral-200 bg-white p-6 sm:p-8"
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Get started with CarrierAudit
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          A few steps to unlock the full audit experience.
        </p>
      </div>
      <ol className="flex flex-col gap-3">
        {items.map((item) => (
          <ChecklistItem key={item.number} item={item} />
        ))}
      </ol>
    </section>
  );
}

function ChecklistItem({ item }: { item: ChecklistItemState }): React.JSX.Element {
  const showCheck = item.done && !item.alwaysActionable;
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between',
        showCheck
          ? 'border-emerald-200 bg-emerald-50/40'
          : item.disabled
            ? 'border-neutral-200 bg-neutral-50/60'
            : 'border-neutral-200 bg-white',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            showCheck
              ? 'bg-emerald-600 text-white'
              : item.disabled
                ? 'bg-neutral-200 text-neutral-500'
                : 'bg-neutral-900 text-neutral-50',
          )}
        >
          {showCheck ? (
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
              <path
                fillRule="evenodd"
                d="M16.704 5.29a1 1 0 0 1 .006 1.415l-7.5 7.59a1 1 0 0 1-1.42.005L3.29 9.79a1 1 0 1 1 1.42-1.41l3.79 3.81 6.79-6.87a1 1 0 0 1 1.414-.03Z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            item.number
          )}
        </span>
        <div>
          <p
            className={cn(
              'text-sm font-medium',
              item.disabled ? 'text-neutral-500' : 'text-neutral-900',
            )}
          >
            {item.label}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">{item.why}</p>
        </div>
      </div>
      <div className="sm:shrink-0">
        {item.disabled ? (
          <Button size="sm" variant="outline" disabled>
            {item.cta}
          </Button>
        ) : (
          <Link href={item.href}>
            <Button size="sm" variant={showCheck ? 'outline' : 'default'}>
              {showCheck ? 'Done' : item.cta}
            </Button>
          </Link>
        )}
      </div>
    </li>
  );
}
