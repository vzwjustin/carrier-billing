'use client';

import { ErrorFallback } from '@/components/error-fallback';

export default function AuthError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return <ErrorFallback {...props} title="Authentication error" />;
}
