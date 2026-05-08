import type { Metadata } from 'next';

import { PricingCards } from '@/components/marketing/pricing-cards';

export const metadata: Metadata = {
  title: 'Pricing — CarrierAudit',
  description:
    'Audit your business wireless bill for $149, or subscribe at $99/month for unlimited audits and monthly drift alerts.',
};

export default function PricingPage(): React.ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
          Simple, honest pricing
        </h1>
        <p className="max-w-2xl text-sm text-neutral-600 sm:text-base">
          Audit any Verizon, AT&amp;T, or T-Mobile business wireless bill in
          under five minutes. Pay per bill, or audit everything every month.
        </p>
      </div>
      <PricingCards />
      <p className="text-center text-xs text-neutral-500">
        Prices in USD. Cancel anytime from the customer portal.
      </p>
    </div>
  );
}
