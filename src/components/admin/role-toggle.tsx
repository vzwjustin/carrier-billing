'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { setUserRoleAction } from '@/app/(app)/admin/actions';
import { Button } from '@/components/ui/button';

export interface RoleToggleProps {
  userId: string;
  role: 'user' | 'admin';
  self: boolean;
}

export function RoleToggle({ userId, role, self }: RoleToggleProps): React.JSX.Element {
  const [current, setCurrent] = useState<'user' | 'admin'>(role);
  const [pending, startTransition] = useTransition();

  const next = current === 'admin' ? 'user' : 'admin';

  function onToggle(): void {
    startTransition(async () => {
      const result = await setUserRoleAction({ userId, role: next });
      if (result.ok) {
        setCurrent(next);
        toast.success(`Role set to ${next}.`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className={
          current === 'admin'
            ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
        }
      >
        {current}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending || (self && current === 'admin')}
        onClick={onToggle}
        title={self && current === 'admin' ? 'You cannot remove your own admin role' : undefined}
      >
        {pending ? '…' : `Make ${next}`}
      </Button>
    </div>
  );
}
