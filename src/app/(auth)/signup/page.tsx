import Link from 'next/link';

import { SignupForm } from './signup-form';

export const metadata = {
  title: 'Sign up — CarrierAudit',
};

export default function SignupPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Create your account
        </h1>
        <p className="text-sm text-neutral-500">Audit your first wireless bill in minutes.</p>
      </div>
      <SignupForm />
      <p className="text-center text-sm text-neutral-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-neutral-900 underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
