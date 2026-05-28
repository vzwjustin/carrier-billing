import Image from 'next/image';
import Link from 'next/link';
import { Upload, FileSearch, Sparkles } from 'lucide-react';

import { SiteNav } from '@/components/marketing/site-nav';
import { SiteFooter } from '@/components/marketing/site-footer';

// Flip to `true` once `public/report-sample.png` is in place. Keeps the
// "coming soon" placeholder visible until the asset lands.
const SAMPLE_REPORT_IMAGE_AVAILABLE = false;

export default function HomePage(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900">
      <SiteNav />
      <main className="flex-1">
        <Hero />
        <TrustBar />
        <HowItWorks />
        <WhatWeFind />
        <SampleReport />
        <PricingTeaser />
        <Faq />
      </main>
      <SiteFooter />
    </div>
  );
}

function Hero(): React.ReactElement {
  return (
    <section className="border-b border-neutral-200">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 lg:grid-cols-2 lg:py-24">
        <div className="flex flex-col gap-6">
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-900 sm:text-5xl lg:text-6xl">
            Stop overpaying on your business wireless bill.
          </h1>
          <p className="max-w-xl text-base text-neutral-600 sm:text-lg">
            Upload your Verizon, AT&amp;T, or T-Mobile bill &mdash; get a
            professional audit with quantified monthly and annual savings in
            under 5 minutes.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="inline-flex h-11 items-center justify-center rounded-md bg-neutral-900 px-6 text-sm font-medium text-neutral-50 hover:bg-neutral-800"
            >
              Run a free preview
            </Link>
            <Link
              href="/pricing"
              className="inline-flex h-11 items-center justify-center rounded-md border border-neutral-300 bg-white px-6 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
            >
              See pricing
            </Link>
          </div>
        </div>
        <div className="hidden lg:block">
          <HeroVisual />
        </div>
      </div>
    </section>
  );
}

function HeroVisual(): React.ReactElement {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-6 shadow-sm">
      <div className="flex items-center justify-between border-b border-neutral-200 pb-3">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Audit summary
        </span>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
          12 findings
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-1">
        <span className="text-sm text-neutral-500">
          Estimated monthly savings
        </span>
        <span className="text-4xl font-semibold tracking-tight text-neutral-900">
          $1,847
        </span>
        <span className="text-sm text-neutral-500">
          $22,164 / year &middot; 80 lines &middot; Verizon Business
        </span>
      </div>
      <div className="mt-6 flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2">
          <span className="text-neutral-700">
            Expired promotional credits
          </span>
          <span className="font-medium text-neutral-900">$420/mo</span>
        </div>
        <div className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2">
          <span className="text-neutral-700">
            Completed device payments
          </span>
          <span className="font-medium text-neutral-900">$612/mo</span>
        </div>
        <div className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2">
          <span className="text-neutral-700">
            Insurance on suspended lines
          </span>
          <span className="font-medium text-neutral-900">$240/mo</span>
        </div>
      </div>
    </div>
  );
}

function TrustBar(): React.ReactElement {
  // TODO(domain): replace with real, defensible auditor stat once Justin confirms.
  return (
    <section className="border-b border-neutral-200 bg-neutral-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 text-center text-sm text-neutral-600">
        Built by telecom auditors with 15+ years auditing carrier spend for
        US businesses.
      </div>
    </section>
  );
}

function HowItWorks(): React.ReactElement {
  const steps = [
    {
      icon: Upload,
      title: 'Upload a PDF',
      body:
        'Drag and drop your most recent Verizon, AT&T, or T-Mobile business wireless bill.',
    },
    {
      icon: FileSearch,
      title: 'AI extracts every line',
      body:
        'We normalize accounts, lines, plans, features, credits, and device installments.',
    },
    {
      icon: Sparkles,
      title: 'Audit rules surface waste',
      body:
        'A rules engine quantifies expired credits, unused features, and wrong plans — with recommended actions.',
    },
  ] as const;

  return (
    <section className="border-b border-neutral-200">
      <div className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">
            How it works
          </h2>
          <p className="max-w-2xl text-sm text-neutral-600 sm:text-base">
            Three steps. No carrier login, no manual data entry.
          </p>
        </div>
        <ol className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <li
                key={step.title}
                className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-6"
              >
                <div className="flex items-center justify-between">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-neutral-900 text-neutral-50">
                    <Icon className="h-4 w-4" aria-hidden />
                  </div>
                  <span className="text-xs font-medium text-neutral-400">
                    Step {index + 1}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-neutral-900">
                  {step.title}
                </h3>
                <p className="text-sm text-neutral-600">{step.body}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function WhatWeFind(): React.ReactElement {
  const findings = [
    {
      title: 'Expired promotional credits',
      body:
        'Promo credits that have rolled off, raising your monthly without a plan change.',
    },
    {
      title: 'Completed device payments still being billed',
      body:
        'Equipment installments that finished but the line item never came off.',
    },
    {
      title: 'Insurance on suspended lines',
      body:
        'Asurion, Mobile Protect, and AppleCare charges on lines no one is using.',
    },
    {
      title: 'Stale international plans',
      body:
        'TravelPass and global add-ons still billing months after the trip ended.',
    },
    {
      title: 'Unused MiFi/jetpack lines',
      body:
        'Hotspot devices on the bill with effectively zero data usage.',
    },
    {
      title: 'Plans on legacy unlimited tiers',
      body:
        'Lines on deprecated plans that cost more than the current equivalent.',
    },
  ] as const;

  return (
    <section className="border-b border-neutral-200 bg-neutral-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">
            What we find
          </h2>
          <p className="max-w-2xl text-sm text-neutral-600 sm:text-base">
            Common waste patterns across business wireless bills.
          </p>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {findings.map((f) => (
            <div
              key={f.title}
              className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-5"
            >
              <h3 className="text-sm font-semibold text-neutral-900">
                {f.title}
              </h3>
              <p className="text-sm text-neutral-600">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SampleReport(): React.ReactElement {
  return (
    <section className="border-b border-neutral-200">
      <div className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">
            Sample report
          </h2>
          <p className="max-w-2xl text-sm text-neutral-600 sm:text-base">
            Quantified findings, recommended actions, and a shareable PDF.
          </p>
        </div>
        <div className="mt-10 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {SAMPLE_REPORT_IMAGE_AVAILABLE ? (
            <Image
              src="/report-sample.png"
              alt="Anonymized CarrierAudit report showing identified annual savings on a Verizon Business account."
              width={1600}
              height={900}
              priority
              className="aspect-[16/9] w-full object-cover"
            />
          ) : (
            <div className="flex aspect-[16/9] w-full items-center justify-center bg-gradient-to-br from-neutral-50 to-neutral-100 px-8">
              <div className="flex flex-col items-center gap-3 text-center">
                <span className="rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium uppercase tracking-wide text-neutral-50">
                  Preview
                </span>
                <p className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">
                  Sample report — coming soon
                </p>
                <p className="max-w-md text-sm text-neutral-600">
                  A full anonymized example will appear here at launch. In the
                  meantime, run a free preview to see the real report on your
                  own bill.
                </p>
              </div>
            </div>
          )}
          <div className="border-t border-neutral-200 px-6 py-4 text-sm text-neutral-600">
            $1,847/mo in waste found on a typical 80-line Verizon Business
            account &mdash; anonymized.
          </div>
        </div>
      </div>
    </section>
  );
}

function PricingTeaser(): React.ReactElement {
  return (
    <section className="border-b border-neutral-200 bg-neutral-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">
            Simple, honest pricing
          </h2>
          <p className="max-w-2xl text-sm text-neutral-600 sm:text-base">
            Pay per bill, or audit everything every month.
          </p>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-6">
            <h3 className="text-sm font-medium text-neutral-500">
              One-time audit
            </h3>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight text-neutral-900">
                $149
              </span>
              <span className="text-sm text-neutral-500">per bill</span>
            </div>
            <p className="text-sm text-neutral-600">
              Run a single audit on one wireless bill.
            </p>
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-neutral-900 bg-white p-6">
            <h3 className="text-sm font-medium text-neutral-500">
              Unlimited subscription
            </h3>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight text-neutral-900">
                $99
              </span>
              <span className="text-sm text-neutral-500">per month</span>
            </div>
            <p className="text-sm text-neutral-600">
              Audit every bill, every month, with drift alerts.
            </p>
          </div>
        </div>
        <div className="mt-8 flex justify-center">
          <Link
            href="/pricing"
            className="inline-flex h-11 items-center justify-center rounded-md bg-neutral-900 px-6 text-sm font-medium text-neutral-50 hover:bg-neutral-800"
          >
            See full pricing
          </Link>
        </div>
      </div>
    </section>
  );
}

function Faq(): React.ReactElement {
  const items = [
    {
      q: 'Which carriers do you support?',
      a: 'Verizon Business, AT&T Business, and T-Mobile for Business in the US.',
    },
    {
      q: 'How accurate is the audit?',
      a: "Each finding includes a confidence indicator. The rules engine uses conservative thresholds; we flag what we'd recommend reviewing.",
    },
    {
      q: 'What about my privacy?',
      a: 'Bills are stored privately in your account and are never shared. We use them only to generate your audit report and improve carrier-specific extraction over time. You can delete an audit any time.',
    },
    {
      q: 'Can I share the report with my finance team?',
      a: 'Yes — every report has a private share link plus a downloadable PDF.',
    },
    {
      q: 'Do you sell the data?',
      a: 'No.',
    },
  ] as const;

  return (
    <section>
      <div className="mx-auto w-full max-w-3xl px-4 py-16">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">
            Frequently asked questions
          </h2>
        </div>
        <div className="mt-8 flex flex-col divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
          {items.map((item) => (
            <details
              key={item.q}
              className="group p-5 [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-neutral-900">
                {item.q}
                <span
                  aria-hidden
                  className="ml-4 text-neutral-400 transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm text-neutral-600">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
