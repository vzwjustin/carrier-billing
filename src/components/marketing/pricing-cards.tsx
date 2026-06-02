'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { trackClient } from '@/lib/analytics/client';
import { cn } from '@/lib/utils';

type Mode = 'one_time' | 'subscription';

type CheckoutResponse = { url?: string; error?: string };

interface PricingCardProps {
  title: string;
  price: string;
  cadence: string;
  description: string;
  bullets: readonly string[];
  ctaLabel: string;
  mode: Mode;
  highlight?: boolean;
}

const ONE_TIME: PricingCardProps = {
  title: 'One-time audit',
  price: '$149',
  cadence: 'per bill',
  description: 'Audit a single statement and walk away with findings.',
  bullets: [
    'Full audit on one wireless bill',
    'All 10 waste-detection rules included',
    'Estimated monthly + annual savings',
    'Shareable web link + downloadable PDF',
    'Money-back guarantee if we find $0',
  ],
  ctaLabel: 'Buy one audit',
  mode: 'one_time',
};

const SUBSCRIPTION: PricingCardProps = {
  title: 'Unlimited subscription',
  price: '$99',
  cadence: 'per month',
  description: 'Audit every bill, every month, every account.',
  bullets: [
    'Unlimited audits across all accounts',
    'Monthly drift alerts on plan changes',
    'CSV / EDI 811 batch import',
    'Priority email support',
    'Cancel anytime from billing portal',
  ],
  ctaLabel: 'Start subscription',
  mode: 'subscription',
  highlight: true,
};

export function PricingCards(): React.ReactElement {
  return (
    <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
      <PricingCard {...ONE_TIME} />
      <PricingCard {...SUBSCRIPTION} />
    </div>
  );
}

function PricingCard(props: PricingCardProps): React.ReactElement {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick(): void {
    setError(null);
    // Phase 5 analytics: fire `checkout_started` BEFORE the network call so
    // we capture intent even when checkout fails or the user is unauthed.
    trackClient({
      name: 'checkout_started',
      properties: { mode: props.mode },
    });
    startTransition(async () => {
      try {
        const res = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: props.mode }),
        });

        if (res.status === 401) {
          window.location.href = '/login?next=/pricing';
          return;
        }

        const data = (await res.json().catch(() => ({}))) as CheckoutResponse;

        if (!res.ok || !data.url) {
          setError(data.error ?? 'Checkout could not be started. Please try again.');
          return;
        }

        window.location.href = data.url;
      } catch {
        setError('Network error. Please try again.');
      }
    });
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-6 rounded-xl border bg-white p-6 shadow-sm',
        props.highlight ? 'border-neutral-900' : 'border-neutral-200',
      )}
    >
      <div>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-neutral-900">{props.title}</h2>
          {props.highlight ? (
            <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs font-medium text-neutral-50">
              Best value
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-neutral-600">{props.description}</p>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold tracking-tight text-neutral-900">
          {props.price}
        </span>
        <span className="text-sm text-neutral-500">{props.cadence}</span>
      </div>

      <ul className="flex flex-col gap-2 text-sm text-neutral-700">
        {props.bullets.map((bullet) => (
          <li key={bullet} className="flex items-start gap-2">
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M16.704 5.296a1 1 0 0 1 0 1.414l-7.5 7.5a1 1 0 0 1-1.414 0l-3.5-3.5a1 1 0 1 1 1.414-1.414L8.5 12.086l6.79-6.79a1 1 0 0 1 1.414 0z"
                clipRule="evenodd"
              />
            </svg>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-2">
        <Button
          onClick={onClick}
          disabled={isPending}
          variant={props.highlight ? 'default' : 'outline'}
          size="lg"
        >
          {isPending ? 'Starting checkout...' : props.ctaLabel}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
