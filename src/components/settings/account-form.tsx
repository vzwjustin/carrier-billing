'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';

import { updateProfileAction } from '@/app/(app)/settings/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface AccountFormProps {
  email: string;
  initialFullName: string | null;
  initialCompanyName: string | null;
}

export function AccountForm({
  email,
  initialFullName,
  initialCompanyName,
}: AccountFormProps): React.JSX.Element {
  const [isPending, startTransition] = useTransition();

  function onSubmit(formData: FormData): void {
    const fullName = String(formData.get('full_name') ?? '').trim();
    const companyName = String(formData.get('company_name') ?? '').trim();

    startTransition(async () => {
      const result = await updateProfileAction({
        full_name: fullName,
        company_name: companyName,
      });
      if (result.ok) {
        toast.success('Profile saved.');
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form action={onSubmit} className="space-y-5" data-netlify="false">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          readOnly
          disabled
          aria-describedby="email-hint"
        />
        <p id="email-hint" className="text-xs text-neutral-500">
          Email is managed by your sign-in provider and can&apos;t be changed
          here.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="full_name">Full name</Label>
        <Input
          id="full_name"
          name="full_name"
          type="text"
          maxLength={120}
          defaultValue={initialFullName ?? ''}
          placeholder="Jordan Doe"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="company_name">Company</Label>
        <Input
          id="company_name"
          name="company_name"
          type="text"
          maxLength={120}
          defaultValue={initialCompanyName ?? ''}
          placeholder="Acme Wireless"
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
