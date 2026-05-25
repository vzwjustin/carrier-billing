import Link from 'next/link';

export function SiteNav(): React.ReactElement {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-neutral-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
        <Link
          href="/"
          className="text-base font-semibold tracking-tight text-neutral-900"
        >
          CarrierAudit
        </Link>
        <nav className="flex items-center gap-1 sm:gap-3">
          <Link
            href="/docs"
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:text-neutral-900"
          >
            Docs
          </Link>
          <Link
            href="/pricing"
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:text-neutral-900"
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:text-neutral-900"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-9 items-center justify-center rounded-md bg-neutral-900 px-3 text-sm font-medium text-neutral-50 hover:bg-neutral-800"
          >
            Sign up
          </Link>
        </nav>
      </div>
    </header>
  );
}
