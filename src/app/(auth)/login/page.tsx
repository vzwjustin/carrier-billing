import Link from 'next/link';
import { Suspense } from 'react';

import { LoginForm } from './login-form';

export const metadata = {
  title: 'Log in — CarrierAudit',
};

export default function LoginPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Log in
        </h1>
        <p className="text-sm text-neutral-500">
          Welcome back. Enter your credentials to access your audits.
        </p>
      </div>
      {/* M4: Suspense wraps the form because `useSearchParams()` opts the
          tree out of static rendering in Next 15. The fallback is empty
          because the form is interactive only. */}
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
      <p className="text-center text-sm text-neutral-500">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="font-medium text-neutral-900 underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
