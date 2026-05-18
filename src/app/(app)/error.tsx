'use client';

import { ErrorFallback } from '@/components/error-fallback';

export default function AppError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return <ErrorFallback {...props} />;
}
