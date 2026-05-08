import { UploadForm } from '@/components/upload/upload-form';

export const metadata = {
  title: 'New audit — CarrierAudit',
};

export default function NewAuditPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          New audit
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Drop a PDF of a Verizon, AT&amp;T, or T-Mobile business wireless bill.
          We&apos;ll have results in under 5 minutes.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <UploadForm />
      </div>
    </div>
  );
}
