'use client';

import { useEffect, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { resendSignupConfirmationAction } from '../reset-password/actions';
import { signUpAction } from './actions';

const SignupSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long'),
});

type SignupInput = z.infer<typeof SignupSchema>;

const RESEND_COOLDOWN_SECONDS = 60;

export function SignupForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupInput>({
    resolver: zodResolver(SignupSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = (data: SignupInput) => {
    setServerError(null);
    startTransition(async () => {
      const result = await signUpAction(data);
      if (!result.ok) {
        setServerError(result.error);
        return;
      }
      setSubmittedEmail(data.email);
    });
  };

  if (submittedEmail) {
    return <CheckEmailView email={submittedEmail} />;
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          disabled={isPending}
          {...register('email')}
        />
        {errors.email ? (
          <p className="text-xs text-red-600">{errors.email.message}</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          disabled={isPending}
          {...register('password')}
        />
        {errors.password ? (
          <p className="text-xs text-red-600">{errors.password.message}</p>
        ) : null}
      </div>
      {serverError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {serverError}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}

function CheckEmailView({ email }: { email: string }): React.JSX.Element {
  // Start the cooldown immediately to discourage instant re-resending: the
  // user just received the original email seconds ago.
  const [cooldown, setCooldown] = useState<number>(RESEND_COOLDOWN_SECONDS);
  const [isResending, startResendTransition] = useTransition();

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => {
      setCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [cooldown]);

  const handleResend = () => {
    if (cooldown > 0 || isResending) return;
    startResendTransition(async () => {
      const result = await resendSignupConfirmationAction({ email });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Confirmation email sent');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    });
  };

  const disabled = cooldown > 0 || isResending;
  const label = isResending
    ? 'Sending…'
    : cooldown > 0
      ? `Resend email (${cooldown}s)`
      : 'Resend email';

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
        <p className="font-medium text-neutral-900">Check your email</p>
        <p>
          We sent a confirmation link to{' '}
          <span className="font-medium">{email}</span>. Click the link to
          activate your account.
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-neutral-500">Didn&apos;t get the email?</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleResend}
          disabled={disabled}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}
