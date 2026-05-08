import type { Metadata } from 'next';

import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteNav } from '@/components/marketing/site-nav';

export const metadata: Metadata = {
  title: 'Privacy Policy — CarrierAudit',
  description: 'How CarrierAudit collects, uses, and protects your data.',
};

export default function PrivacyPage(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900">
      <SiteNav />
      <main className="flex-1">
        <article className="mx-auto w-full max-w-3xl px-4 py-12">
          <PlaceholderBanner />
          <header className="mt-8 flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
              Privacy Policy
            </h1>
            <p className="text-sm text-neutral-500">
              Last updated: May 8, 2026
            </p>
          </header>

          <div className="mt-8 flex flex-col gap-8 text-sm leading-6 text-neutral-700 sm:text-base sm:leading-7">
            <p>
              CarrierAudit helps you find waste in your business wireless
              bill. This policy explains, in plain English, what we collect
              and how we handle it.
            </p>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                What we collect
              </h2>
              <p>
                When you create an account we collect your email address and
                (optionally) your name and company name. When you upload a
                bill we collect the PDF you upload and the structured data
                we extract from it &mdash; carrier, billing period, accounts,
                lines, plans, features, credits, and device installments.
                Phone numbers and account numbers are stored in masked form
                (last four digits only).
              </p>
              <p>
                We use Stripe to process payments. Stripe receives your
                payment details directly; we never see or store your card
                number.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                How we use it
              </h2>
              <p>
                We use the data you provide to generate your audit report
                and to send you transactional emails (audit complete,
                receipts, account notifications). We use aggregate, anonymized
                signals from extracted bills to improve carrier-specific
                extraction quality over time. We do not use your bills to
                train third-party models.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Storage and retention
              </h2>
              <p>
                Bills and reports are stored in our hosted database and
                object storage, located in the United States. Access is
                restricted to your account through row-level security. We
                retain audits for as long as your account is active. You can
                delete any individual audit at any time, which removes the
                PDF, the extracted data, and the report.
              </p>
              <p>
                If you close your account, we delete your audits within 30
                days, except where we are required to retain billing records
                for tax or accounting purposes.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Sharing
              </h2>
              <p>
                We do not sell your data. We share data only with the
                service providers we use to run the product: our hosting
                provider, our database provider, our payment processor, our
                email provider, our error monitoring provider, and the model
                provider that powers extraction. Each is contractually
                obligated to protect your data.
              </p>
              <p>
                Reports are private by default. If you generate a share
                link, anyone with that link can view the report; you can
                revoke share links at any time.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Your rights
              </h2>
              <p>
                You can access, correct, export, or delete your data from
                your settings page, or by emailing us. Depending on where
                you live you may have additional rights under laws such as
                CCPA or GDPR; we will honor verified requests under those
                laws.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Contact
              </h2>
              <p>
                Questions about this policy?{' '}
                <a
                  href="mailto:hello@carrieraudit.com"
                  className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
                >
                  hello@carrieraudit.com
                </a>
                .
              </p>
            </section>
          </div>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}

function PlaceholderBanner(): React.ReactElement {
  return (
    <div
      role="note"
      className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      <strong className="font-semibold">PLACEHOLDER</strong> &mdash; finalize
      before launch. This document has not been reviewed by counsel.
    </div>
  );
}
