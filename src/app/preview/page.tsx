import Link from 'next/link';

export const dynamic = 'force-static';

export default function PreviewIndexPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-neutral-900">
        Component previews
      </h1>
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
      </ul>
    </div>
  );
}
