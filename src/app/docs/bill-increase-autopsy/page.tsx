import type { Metadata } from 'next';
import Link from 'next/link';

import { CHANGE_CATEGORIES } from '@/autopsy/types';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Bill Increase Autopsy — CarrierAudit docs',
  description:
    'How the Bill Increase Autopsy compares two completed audits and bucket-sorts every dollar of change into disputable, optimization, or unexplained.',
};

const CATEGORY_DESCRIPTIONS: Record<
  (typeof CHANGE_CATEGORIES)[number],
  { label: string; body: string }
> = {
  new_lines: {
    label: 'New lines',
    body: 'Lines on the current bill that weren’t on the previous one.',
  },
  removed_lines: {
    label: 'Removed lines',
    body: 'Lines on the previous bill that are gone this period.',
  },
  plan_changes: {
    label: 'Plan changes',
    body: 'Same line, different plan name or different base rate.',
  },
  device_installments_added: {
    label: 'Device installments added',
    body: 'New device-payment-plan rows that weren’t billing before.',
  },
  device_installments_removed: {
    label: 'Device installments removed',
    body: 'DPP rows that finished or were taken off the bill.',
  },
  missing_credits: {
    label: 'Missing credits',
    body: 'Credits that were on the previous bill but are absent now.',
  },
  new_credits: {
    label: 'New credits',
    body: 'Credits that appear this period that weren’t there before.',
  },
  credits_decreased: {
    label: 'Credits decreased',
    body: 'Same credit, smaller amount applied this period.',
  },
  credits_increased: {
    label: 'Credits increased',
    body: 'Same credit, larger amount applied this period.',
  },
  one_time_charges: {
    label: 'One-time charges',
    body: 'Adjustments, prior balance, prorations, and other one-off items.',
  },
  activation_fees: {
    label: 'Activation fees',
    body: 'New connection / upgrade / activation fees on the current bill.',
  },
  insurance_changes: {
    label: 'Insurance changes',
    body: 'Asurion, Mobile Protect, AppleCare, and similar add or drop.',
  },
  international_charges: {
    label: 'International charges',
    body: 'TravelPass, international day passes, and global plan items.',
  },
  roaming_charges: {
    label: 'Roaming charges',
    body: 'Pay-per-use roaming or roaming overage line items.',
  },
  overage_charges: {
    label: 'Overage charges',
    body: 'Data, voice, or message overages above plan thresholds.',
  },
  taxes_fees_change: {
    label: 'Taxes & fees change',
    body: 'Net change to surcharges, taxes, and regulatory fees at the account level.',
  },
  feature_addon_changes: {
    label: 'Feature / add-on changes',
    body: 'Hotspot, cloud storage, premium voicemail, and other recurring add-ons.',
  },
  suspended_line_still_billed: {
    label: 'Suspended line still billed',
    body: 'A line marked suspended that’s still accruing charges this period.',
  },
  unexplained: {
    label: 'Unexplained',
    body: 'Residual delta the engine cannot attribute to any specific driver — a human review prompt.',
  },
};

export default function AutopsyDocsPage(): React.ReactElement {
  return (
    <div className="flex flex-col gap-10 text-neutral-700">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Bill Increase Autopsy
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
          Why did the bill go up?
        </h1>
        <p className="max-w-2xl text-sm sm:text-base">
          When a customer&apos;s wireless bill jumps month over month, the
          first question is always &ldquo;what changed?&rdquo;. The Bill
          Increase Autopsy answers it line by line by comparing two
          completed audits and bucket-sorting every dollar of change into
          named drivers.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          Inputs
        </h2>
        <p>
          The autopsy needs two{' '}
          <strong>completed</strong> audits owned by the same account
          &mdash; a previous-period audit and a current-period audit. From
          the dashboard, open a completed audit and click{' '}
          <strong>Run autopsy vs previous</strong>; CarrierAudit picks the
          most recent prior audit on the same carrier as the comparator
          (you can override).
        </p>
        <p>
          The engine itself is a pure transformation: it consumes two
          extracted bills and emits a categorized breakdown. There&apos;s
          no carrier API call, no PDF re-fetch, and no LLM round trip at
          autopsy time &mdash; everything was already extracted when each
          audit ran.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          Change driver categories
        </h2>
        <p>
          The engine emits at most one <em>driver</em> per category. Each
          driver carries a signed dollar delta, a list of affected lines,
          and a confidence score. The full set of categories is:
        </p>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {CHANGE_CATEGORIES.map((category) => {
            const def = CATEGORY_DESCRIPTIONS[category];
            return (
              <li
                key={category}
                className="flex flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-4"
              >
                <span className="text-sm font-semibold text-neutral-900">
                  {def.label}
                </span>
                <code className="text-xs text-neutral-500">{category}</code>
                <p className="text-sm text-neutral-600">{def.body}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          Disputable vs optimization vs unexplained
        </h2>
        <p>
          Every driver is tagged with three booleans the report uses to
          group the breakdown for the reader:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Disputable</strong> &mdash; the delta looks like a
            carrier error or a missing credit you&apos;re entitled to.
            Examples: missing credits, suspended-but-billed, activation
            fees on an established line, taxes/fees that jumped out of
            proportion to charges. These feed the dispute-packet workflow.
          </li>
          <li>
            <strong>Optimization</strong> &mdash; the delta is real, but
            it&apos;s a plan or feature decision you can change.
            Examples: new lines, new device installments, plan upgrades,
            new insurance, international add-ons that should have been
            day passes.
          </li>
          <li>
            <strong>Unexplained</strong> &mdash; the residual the engine
            can&apos;t attribute. We surface this as a separate{' '}
            <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs text-neutral-800">
              unexplained
            </code>{' '}
            driver rather than padding another bucket. If the unexplained
            total is large, that&apos;s your cue to dig into the raw
            extracted bill data, not the autopsy.
          </li>
        </ul>
        <p>
          The hero number at the top of every autopsy is the net change in
          total charges. Below that we always show the three subtotals:
          disputable dollars, optimization dollars, and unexplained
          dollars. They add up to the net change exactly.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          The &ldquo;never invent a cause&rdquo; discipline
        </h2>
        <p>
          The autopsy is intentionally allergic to plausible-sounding
          narratives that aren&apos;t backed by line-level evidence. Three
          rules the engine follows strictly:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            One driver per category, never more. We won&apos;t split
            &ldquo;plan changes&rdquo; into &ldquo;upgrade&rdquo; and
            &ldquo;downgrade&rdquo; sub-buckets just to make the narrative
            tidier &mdash; the per-line evidence is right there in the
            driver&apos;s line list.
          </li>
          <li>
            No causes attributed without per-line evidence. Every driver
            ships with the affected lines (account-last4 + mdn-last4 +
            previous/current cents) so a reader can verify.
          </li>
          <li>
            Residual stays as <code>unexplained</code>. If the categorized
            drivers don&apos;t sum to the net change, the gap surfaces as
            an unexplained driver rather than being silently absorbed into
            an adjacent bucket.
          </li>
        </ul>
        <p>
          The point is that the autopsy is meant to be defensible in front
          of a CFO or a carrier rep. Every dollar of attributed change
          links back to specific bill lines.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          What to do next
        </h2>
        <p>
          Disputable drivers usually translate directly into a{' '}
          <Link
            href="/docs/dispute-packets"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
          >
            dispute packet
          </Link>
          . Optimization drivers feed into the same conversation as the{' '}
          <Link
            href="/docs/rules"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
          >
            rules engine findings
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
