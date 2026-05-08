import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Minimal pulsing placeholder for async surfaces. Compose multiple Skeletons
 * inside a layout to mirror the eventual content shape.
 */
export function Skeleton({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded bg-neutral-200', className)}
    />
  );
}
