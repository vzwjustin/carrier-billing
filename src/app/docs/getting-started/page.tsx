import type { Metadata } from 'next';
import Link from 'next/link';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Getting started — CarrierAudit docs',
  description:
    'How to sign up, upload your first wireless bill, and read your first audit report.',
};

export default function GettingStartedPage(): React.ReactElement {
  return (
    <div className="flex flex-col gap-10 text-neutral-700">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Getting started
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
          Your first audit, end to end
        </h1>
        <p className="max-w-2xl text-sm sm:text-base">
          CarrierAudit turns a PDF wireless bill into a quantified savings
          report in under five minutes. This page walks you through what
          happens between upload and the report you can hand to finance.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          What CarrierAudit does
        </h2>
        <p>
          We ingest a PDF of your US business wireless bill from Verizon,
          AT&amp;T, T-Mobile, or one of the regional carriers and MVNOs we
          support, extract every account, line, plan, feature, credit, and
          device-installment row, then run an auditor&apos;s rules engine
          over the result. The output is a report listing every waste
          pattern we found, with an estimated monthly savings number and a
          recommended action for each one.
        </p>
        <p>
          The product is read-only: we never log in to your carrier portal
          or change anything on your account. You take the recommended
          actions yourself, or hand the report to your carrier rep or
          telecom-expense-management (TEM) partner.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          Signing up
        </h2>
        <p>
          Create an account at{' '}
          <Link
            href="/signup"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
          >
            /signup
          </Link>
          {' '}with an email address and password. We send a verification
          email; once that round-trips you&apos;re in. Pick the one-time
          $149 audit or the $99/month unlimited subscription on the{' '}
          <Link
            href="/pricing"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
          >
            pricing page
          </Link>
          . You can switch between them later.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          Uploading your first bill
        </h2>
        <p>
          From the dashboard, click <strong>New audit</strong> and drag in
          a PDF of your most recent bill. A few requirements:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>PDF only, up to 25 MB.</li>
          <li>
            US business wireless &mdash; we don&apos;t parse consumer,
            wireline, fiber, or non-US bills.
          </li>
          <li>
            Whole-bill PDFs work best. Detail-section-only exports
            sometimes miss the billing-period header.
          </li>
          <li>
            Scanned-image bills are fine; we fall back to OCR
            automatically when the embedded text is too thin.
          </li>
        </ul>
        <p>
          The upload page shows a live stepper:{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs text-neutral-800">
            Uploading
          </code>{' '}
          →{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs text-neutral-800">
            Extracting
          </code>{' '}
          →{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs text-neutral-800">
            Analyzing
          </code>{' '}
          →{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs text-neutral-800">
            Completed
          </code>
          . You can close the tab; the email-on-complete will land in
          your inbox when the audit finishes.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          Reading your first report
        </h2>
        <p>
          The report opens with a hero card showing estimated monthly and
          annual savings across all findings, a count by severity, and a
          one-line bill summary (carrier, billing period, account count,
          line count, total charges).
        </p>
        <p>
          Findings are grouped by severity, then by category. Each
          finding card carries a title, description, recommended action,
          estimated monthly savings, a confidence badge, and a
          collapsible list of affected lines. See the{' '}
          <Link
            href="/docs/rules"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
          >
            rules engine page
          </Link>
          {' '}for what each rule looks for.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          What to expect from the first audit
        </h2>
        <p>
          A typical 50&ndash;100 line business account turns up a handful
          of high-severity findings worth real money &mdash; usually some
          combination of expired promo credits, completed device payments
          that never came off, suspended-but-billed lines, and stale
          international features. Low-severity findings are intentionally
          quieter signals worth a periodic glance.
        </p>
        <p>
          The engine is deliberately conservative. Every finding ships
          with a confidence indicator so you know which to act on
          immediately and which need a human review.
        </p>
      </section>

      <section id="faq" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          Where to next
        </h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <Link
              href="/docs/rules"
              className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              Rules engine
            </Link>{' '}
            &mdash; every rule the audit runs.
          </li>
          <li>
            <Link
              href="/docs/bill-increase-autopsy"
              className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              Bill Increase Autopsy
            </Link>{' '}
            &mdash; compare two months when the total jumps.
          </li>
          <li>
            <Link
              href="/docs/dispute-packets"
              className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              Dispute packets
            </Link>{' '}
            &mdash; turn findings into carrier-ready letters and emails.
          </li>
        </ul>
      </section>
    </div>
  );
}
