import Link from 'next/link';

export function SiteFooter(): React.ReactElement {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-16 border-t border-neutral-200 bg-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-neutral-600 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-neutral-900">CarrierAudit</span>
          <span className="text-xs text-neutral-500">
            &copy; {year} CarrierAudit. All rights reserved.
          </span>
        </div>
        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center gap-x-5 gap-y-2"
        >
          <Link
            href="/share/verizon_business_large_sample_v1"
            className="hover:text-neutral-900"
          >
            Sample report
          </Link>
          <Link href="/pricing" className="hover:text-neutral-900">
            Pricing
          </Link>
          <Link href="/privacy" className="hover:text-neutral-900">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-neutral-900">
            Terms
          </Link>
          <a
            href="mailto:hello@carrieraudit.com"
            className="hover:text-neutral-900"
          >
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}
