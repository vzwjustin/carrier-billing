import type { Metadata } from 'next';
import Link from 'next/link';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Documentation — CarrierAudit',
  description:
    'Start here. Learn how CarrierAudit audits your wireless bill, what the rules engine looks for, and how to act on findings.',
};

const CARDS: ReadonlyArray<{
  href: string;
  title: string;
  body: string;
}> = [
  {
    href: '/docs/getting-started',
    title: 'Getting started',
    body: 'Sign up, upload your first PDF, and what to expect in your first audit.',
  },
  {
    href: '/docs/rules',
    title: 'Rules engine',
    body: 'Every rule the engine runs, what it looks for, and which carriers it applies to.',
  },
  {
    href: '/docs/bill-increase-autopsy',
    title: 'Bill Increase Autopsy',
    body: 'Compare two months side-by-side to explain every dollar of change.',
  },
  {
    href: '/docs/dispute-packets',
    title: 'Dispute packets',
    body: 'Carrier-ready PDFs and email drafts for findings worth pushing back on.',
  },
  {
    href: '/docs/getting-started#faq',
    title: 'FAQ',
    body: 'Common questions about carriers, accuracy, privacy, and pricing.',
  },
];

export default function DocsIndexPage(): React.ReactElement {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          Documentation
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
          CarrierAudit documentation
        </h1>
        <p className="max-w-2xl text-sm text-neutral-600 sm:text-base">
          Everything you need to upload a wireless bill, read the audit report, and turn findings
          into recovered spend. Start with{' '}
          <Link
            href="/docs/getting-started"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
          >
            Getting started
          </Link>{' '}
          if you&apos;re new.
        </p>
      </header>

      <section
        aria-label="Documentation sections"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        {CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5 transition hover:border-neutral-400 hover:bg-neutral-50"
          >
            <h2 className="text-base font-semibold text-neutral-900 group-hover:text-neutral-700">
              {card.title}
            </h2>
            <p className="text-sm text-neutral-600">{card.body}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
