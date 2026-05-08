import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="text-xl font-semibold tracking-tight text-neutral-900"
          >
            CarrierAudit
          </Link>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-8 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
