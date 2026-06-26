import * as React from 'react';

import type { ReportAudit } from '@/reports/types';
import { formatCents } from '@/lib/utils';

export interface SavingsHeroProps {
  audit: ReportAudit;
}

export function SavingsHero({ audit }: SavingsHeroProps): React.JSX.Element {
  const monthly = audit.estimated_monthly_savings_cents;
  const annual =
    audit.estimated_annual_savings_cents > 0 ? audit.estimated_annual_savings_cents : monthly * 12;
  const findings = audit.finding_count;
  const highSeverity = audit.high_severity_count;
  const positive = monthly > 0;

  return (
    <section
      className={
        positive
          ? 'rounded-xl border border-emerald-200 bg-emerald-50 p-6 sm:p-8'
          : 'rounded-xl border border-neutral-200 bg-white p-6 sm:p-8'
      }
      aria-label="Estimated savings summary"
    >
      <p
        className={
          positive
            ? 'text-xs font-medium tracking-wider text-emerald-700 uppercase'
            : 'text-xs font-medium tracking-wider text-neutral-600 uppercase'
        }
      >
        Estimated savings
      </p>

      <div className="mt-4 flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-12">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-12">
          <div>
            <p
              className={
                positive
                  ? 'text-4xl font-semibold tracking-tight text-emerald-900 sm:text-5xl'
                  : 'text-4xl font-semibold tracking-tight text-neutral-900 sm:text-5xl'
              }
            >
              {formatCents(monthly)}
            </p>
            <p
              className={
                positive ? 'mt-1 text-sm text-emerald-800' : 'mt-1 text-sm text-neutral-600'
              }
            >
              per month
            </p>
          </div>
          <div>
            <p
              className={
                positive
                  ? 'text-4xl font-semibold tracking-tight text-emerald-900 sm:text-5xl'
                  : 'text-4xl font-semibold tracking-tight text-neutral-900 sm:text-5xl'
              }
            >
              {formatCents(annual)}
            </p>
            <p
              className={
                positive ? 'mt-1 text-sm text-emerald-800' : 'mt-1 text-sm text-neutral-600'
              }
            >
              per year
            </p>
          </div>
        </div>

        <div className="flex flex-row gap-4 sm:gap-6">
          <FindingStat label="Findings" value={findings} tone={positive ? 'emerald' : 'neutral'} />
          <FindingStat
            label="High severity"
            value={highSeverity}
            tone={highSeverity > 0 ? 'red' : positive ? 'emerald' : 'neutral'}
          />
        </div>
      </div>
    </section>
  );
}

type Tone = 'emerald' | 'neutral' | 'red';

const TONE_LABEL: Record<Tone, string> = {
  emerald: 'text-emerald-800',
  neutral: 'text-neutral-600',
  red: 'text-red-700',
};

const TONE_VALUE: Record<Tone, string> = {
  emerald: 'text-emerald-900',
  neutral: 'text-neutral-900',
  red: 'text-red-900',
};

function FindingStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: Tone;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-white/40 bg-white/60 px-4 py-3 backdrop-blur-sm">
      <p className={`text-xs font-medium tracking-wider uppercase ${TONE_LABEL[tone]}`}>{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${TONE_VALUE[tone]}`}>{value}</p>
    </div>
  );
}
