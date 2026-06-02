import Link from 'next/link';

export function SiteNav(): React.ReactElement {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-neutral-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
      {/* Keyboard skip link — visible only when focused */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-emerald-600 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:outline-none"
      >
        Skip to main content
      </a>
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
        <Link
          href="/"
          aria-label="CarrierAudit home"
          className="rounded-md text-base font-semibold tracking-tight text-neutral-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          CarrierAudit
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Primary navigation">
          <Link
            href="/share/verizon_business_large_sample_v1"
            className="hidden rounded-md px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none sm:inline-flex"
          >
            See a sample
          </Link>
          <Link
            href="/docs"
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:text-neutral-900"
          >
            Docs
          </Link>
          <Link
            href="/pricing"
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-600 px-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Audit my bill
          </Link>
        </nav>
      </div>
    </header>
  );
}
