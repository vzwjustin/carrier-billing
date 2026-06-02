import { redirect } from 'next/navigation';

import { ContractUploadForm } from '@/components/contracts/upload-form';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Upload contract — CarrierAudit',
};

export const dynamic = 'force-dynamic';

export default async function NewContractPage(): Promise<React.JSX.Element> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Upload contract</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Drop a PDF of a carrier contract, quote, or promo sheet. We&apos;ll extract plan, pricing,
          and waiver terms — these power the contract-vs-bill audit rules.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <ContractUploadForm />
      </div>
    </div>
  );
}
