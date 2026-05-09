import * as React from 'react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

export type BannerVariant = 'warning' | 'info' | 'success' | 'error';

export type BannerAction = {
  label: string;
  href: string;
};

export type BannerProps = {
  variant: BannerVariant;
  title: string;
  description?: React.ReactNode;
  action?: BannerAction;
  className?: string;
};

const VARIANT_STYLES: Record<
  BannerVariant,
  { container: string; title: string; body: string; action: string }
> = {
  warning: {
    container: 'border-amber-300 bg-amber-50',
    title: 'text-amber-900',
    body: 'text-amber-800',
    action:
      'bg-amber-600 text-white hover:bg-amber-700 focus-visible:ring-amber-700',
  },
  info: {
    container: 'border-neutral-200 bg-neutral-50',
    title: 'text-neutral-900',
    body: 'text-neutral-700',
    action:
      'bg-neutral-900 text-neutral-50 hover:bg-neutral-800 focus-visible:ring-neutral-900',
  },
  success: {
    container: 'border-emerald-200 bg-emerald-50',
    title: 'text-emerald-900',
    body: 'text-emerald-800',
    action:
      'bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:ring-emerald-800',
  },
  error: {
    container: 'border-red-200 bg-red-50',
    title: 'text-red-900',
    body: 'text-red-800',
    action: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-700',
  },
};

export function Banner(props: BannerProps): React.JSX.Element {
  const { variant, title, description, action, className } = props;
  const styles = VARIANT_STYLES[variant];

  return (
    <div
      role={variant === 'error' || variant === 'warning' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg border p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3',
        styles.container,
        className,
      )}
    >
      <div className="space-y-1">
        <p className={cn('text-sm font-semibold', styles.title)}>{title}</p>
        {description ? (
          <div className={cn('text-sm', styles.body)}>{description}</div>
        ) : null}
      </div>
      {action ? (
        <Link
          href={action.href}
          className={cn(
            'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
            styles.action,
          )}
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
