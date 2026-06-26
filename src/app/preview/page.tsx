import Link from 'next/link';

export const dynamic = 'force-static';

export default function PreviewIndexPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-neutral-900">Component previews</h1>
      <ul className="list-inside list-disc space-y-1 text-sm">
        <li>
          <Link href="/preview/autopsy" className="text-blue-600 underline">
            /preview/autopsy
          </Link>{' '}
          — Bill Increase Autopsy with a $843.21 increase
        </li>
        <li>
          <Link href="/preview/findings" className="text-blue-600 underline">
            /preview/findings
          </Link>{' '}
          — Finding cards across all 6 reviewer statuses + read-only variant
        </li>
        <li>
          <Link href="/preview/inventory" className="text-blue-600 underline">
            /preview/inventory
          </Link>{' '}
          — Wireless inventory page with filters + stat tiles
        </li>
        <li>
          <Link href="/preview/assistant" className="text-blue-600 underline">
            /preview/assistant
          </Link>{' '}
          — AI assistant chat with grounded answer + citations
        </li>
        <li>
          <Link href="/preview/contracts" className="text-blue-600 underline">
            /preview/contracts
          </Link>{' '}
          — Contracts library
        </li>
        <li>
          <Link href="/preview/dashboard-card" className="text-blue-600 underline">
            /preview/dashboard-card
          </Link>{' '}
          — Dashboard Bill Increase Autopsy summary tile
        </li>
      </ul>
    </div>
  );
}
