import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">CarrierAudit</h1>
      <p className="max-w-xl text-lg text-[var(--color-muted-foreground)]">
        Upload your business wireless bill and receive a professional audit with quantified
        monthly and annual savings — in under 5 minutes.
      </p>
      <div className="flex gap-3">
        <Link
          href="/signup"
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-foreground)]"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium"
        >
          Log in
        </Link>
      </div>
    </main>
  );
}
