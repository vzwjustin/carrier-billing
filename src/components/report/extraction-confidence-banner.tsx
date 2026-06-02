import * as React from 'react';

export interface ExtractionConfidenceBannerProps {
  /**
   * Bill-level extraction confidence as persisted on the audit row:
   * 'high' | 'medium' | 'low' | null. NULL (pre-migration rows) and 'high'
   * render nothing — we only warn when the parse was degraded.
   */
  confidence: string | null;
}

interface BannerCopy {
  border: string;
  bg: string;
  heading: string;
  body: string;
  label: string;
}

const COPY: Record<'medium' | 'low', BannerCopy> = {
  medium: {
    border: 'border-amber-200',
    bg: 'bg-amber-50',
    label: 'text-amber-700',
    heading: 'text-amber-900',
    body: 'text-amber-800',
  },
  low: {
    border: 'border-red-200',
    bg: 'bg-red-50',
    label: 'text-red-700',
    heading: 'text-red-900',
    body: 'text-red-800',
  },
};

/**
 * Caution banner shown above the savings summary when the bill-level
 * extraction confidence was downgraded during parsing (e.g. the printed total
 * didn't reconcile with the summed line components, or the bill needed OCR).
 *
 * Renders nothing for 'high' confidence or NULL — the common case — so a
 * clean parse shows no chrome at all.
 */
export function ExtractionConfidenceBanner({
  confidence,
}: ExtractionConfidenceBannerProps): React.JSX.Element | null {
  if (confidence !== 'medium' && confidence !== 'low') return null;
  const c = COPY[confidence];

  const heading =
    confidence === 'low'
      ? 'Low-confidence extraction — verify before relying on these figures'
      : 'Reduced-confidence extraction — double-check key figures';

  return (
    <section
      className={`rounded-xl border ${c.border} ${c.bg} p-4 sm:p-5`}
      aria-label="Extraction confidence notice"
      role="status"
    >
      <p className={`text-xs font-medium tracking-wider uppercase ${c.label}`}>
        Extraction confidence: {confidence}
      </p>
      <p className={`mt-1 text-sm font-medium ${c.heading}`}>{heading}</p>
      <p className={`mt-1 text-sm ${c.body}`}>
        Some values on this bill didn&apos;t fully reconcile during parsing — the printed total may
        not match the sum of its line items, or the document needed image-based text recognition.
        The findings below are still useful as leads, but confirm the underlying numbers against
        your bill before acting on the savings estimates.
      </p>
    </section>
  );
}
