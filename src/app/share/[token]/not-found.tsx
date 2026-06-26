import Link from 'next/link';
import { FileSearch } from 'lucide-react';

export default function ShareNotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <div className="bg-card rounded-2xl border p-10 text-center shadow-sm">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
          <FileSearch className="h-8 w-8 text-amber-700" aria-hidden="true" />
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">
          This audit link isn&apos;t available
        </h1>
        <p className="text-muted-foreground mt-3">
          The share link you opened may have expired, been revoked by its owner, or never existed.
          If someone sent you this link, ask them for a fresh one — share tokens can be regenerated
          at any time.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="border-input bg-background hover:bg-muted inline-flex items-center justify-center rounded-lg border px-5 py-2.5 text-sm font-medium shadow-sm transition-colors focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:outline-none"
          >
            Back to home
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:outline-none"
          >
            Audit your own bill
          </Link>
        </div>
      </div>

      <p className="text-muted-foreground mt-6 text-center text-sm">
        Want a working example?{' '}
        <Link
          href="/share/verizon_business_large_sample_v1"
          className="font-medium text-emerald-700 underline-offset-4 hover:underline"
        >
          View a sample Verizon audit
        </Link>
        .
      </p>
    </div>
  );
}
