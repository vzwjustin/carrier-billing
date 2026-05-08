import Link from 'next/link';

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
      <LoginForm />
      <p className="text-center text-sm text-neutral-500">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="font-medium text-neutral-900 underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
