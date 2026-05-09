'use client';

import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { requestPasswordResetAction } from './actions';

const ResetSchema = z.object({
  email: z.string().email('Enter a valid email'),
});

type ResetInput = z.infer<typeof ResetSchema>;

export function ResetPasswordForm() {
  const [serverError, setServerError] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetInput>({
    resolver: zodResolver(ResetSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = (data: ResetInput) => {
    setServerError(null);
    startTransition(async () => {
      const result = await requestPasswordResetAction(data);
      if (!result.ok) {
        setServerError(result.error);
        return;
      }
      setSubmittedEmail(data.email);
    });
  };

  if (submittedEmail) {
    return (
      <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
        <p className="font-medium text-neutral-900">Check your email</p>
        <p>
          If an account exists for{' '}
          <span className="font-medium">{submittedEmail}</span>, we sent a
          password reset link. Click the link to choose a new password.
        </p>
      </div>
    );
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
      {serverError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {serverError}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
