'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { deleteAccountAction } from '@/app/(app)/settings/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface DangerZoneProps {
  email: string;
}

export function DangerZone({ email }: DangerZoneProps): React.JSX.Element {
  const [confirm, setConfirm] = useState('');
  const [isPending, startTransition] = useTransition();

  const matches = confirm.trim().toLowerCase() === email.trim().toLowerCase();

  function onDelete(): void {
    if (!matches) return;
    startTransition(async () => {
      const result = await deleteAccountAction({ confirm_email: confirm });
      if (result.ok) {
        toast.success('Account deleted.');
        window.location.assign('/');
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <section className="space-y-4 rounded-xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900/60 dark:bg-neutral-900">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-red-700 dark:text-red-400">Danger zone</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>
      </header>
      <div className="space-y-2">
        <Label htmlFor="confirm_email">
          Type <span className="font-semibold">{email}</span> to confirm
        </Label>
        <Input
          id="confirm_email"
          name="confirm_email"
          type="email"
          autoComplete="off"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={email}
          disabled={isPending}
        />
      </div>
      <Button
        type="button"
        variant="destructive"
        disabled={!matches || isPending}
        onClick={onDelete}
      >
        {isPending ? 'Deleting…' : 'Delete my account'}
      </Button>
    </section>
  );
}
