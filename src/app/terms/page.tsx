import type { Metadata } from 'next';

import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteNav } from '@/components/marketing/site-nav';

export const metadata: Metadata = {
  title: 'Terms of Service — CarrierAudit',
  description: 'The terms that govern your use of CarrierAudit.',
};

export default function TermsPage(): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900">
      <SiteNav />
      <main className="flex-1">
        <article className="mx-auto w-full max-w-3xl px-4 py-12">
          <PlaceholderBanner />
          <header className="mt-8 flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
              Terms of Service
            </h1>
            <p className="text-sm text-neutral-500">
              Last updated: May 8, 2026
            </p>
          </header>

          <div className="mt-8 flex flex-col gap-8 text-sm leading-6 text-neutral-700 sm:text-base sm:leading-7">
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Acceptance
              </h2>
              <p>
                By creating a CarrierAudit account or uploading a bill, you
                agree to these terms. If you are using CarrierAudit on
                behalf of a company, you represent that you have authority
                to bind that company to these terms.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Service description
              </h2>
              <p>
                CarrierAudit accepts a US business wireless bill (Verizon,
                AT&amp;T, or T-Mobile) in PDF form, extracts a structured
                representation of the bill, and applies a rules engine to
                identify potential waste. The output is a report with
                quantified estimates and recommended actions. Estimates are
                provided for informational purposes; actual savings depend
                on actions you take with your carrier.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                User responsibilities
              </h2>
              <p>
                You are responsible for the accuracy of the bills you
                upload, for keeping your account credentials secure, and
                for ensuring you have the right to upload the bills (for
                example, that they belong to your business or to a client
                that has authorized you).
              </p>
              <p>
                You agree not to upload content that is illegal, malicious,
                or that infringes on someone else&apos;s rights. You agree
                not to attempt to reverse-engineer the service or to abuse
                it in ways that affect other users.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Payment and refunds
              </h2>
              <p>
                One-time audits are billed once at $149 and grant a single
                audit credit. Subscriptions are billed monthly at $99 and
                grant unlimited audits while active. Subscriptions renew
                automatically until canceled.
              </p>
              <p>
                If an audit fails for technical reasons on our side, we
                will refund or re-credit it. If you are not satisfied,
                contact us and we will work with you in good faith.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Disclaimer
              </h2>
              <p>
                The service is provided &ldquo;as is.&rdquo; CarrierAudit
                does not guarantee that any specific finding will be
                accepted by your carrier or that any specific savings will
                be realized. We are not your carrier, your accountant, or
                your legal advisor.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Limitation of liability
              </h2>
              <p>
                To the maximum extent permitted by law, CarrierAudit&apos;s
                total liability for any claim related to the service is
                limited to the amount you paid us in the twelve months
                preceding the claim. We are not liable for indirect,
                incidental, or consequential damages.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Termination
              </h2>
              <p>
                You can cancel your subscription at any time from the
                customer portal; cancellation takes effect at the end of
                your current billing period. We may suspend or terminate
                accounts that violate these terms. On termination we delete
                your audits per our Privacy Policy.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold text-neutral-900">
                Contact
              </h2>
              <p>
                Questions about these terms?{' '}
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
