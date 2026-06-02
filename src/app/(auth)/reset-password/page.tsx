import Link from 'next/link';

import { ResetPasswordForm } from './reset-password-form';

export const metadata = {
  title: 'Reset password — CarrierAudit',
};

export default function ResetPasswordPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Reset your password
        </h1>
        <p className="text-sm text-neutral-500">
          Enter the email on your account and we&apos;ll send you a link to set a new password.
        </p>
      </div>
      <ResetPasswordForm />
      <p className="text-center text-sm text-neutral-500">
        Remembered it?{' '}
        <Link href="/login" className="font-medium text-neutral-900 underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
