export default function AppLoading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-8">
      <span className="sr-only">Loading…</span>

      {/* Hero card skeleton */}
      <div className="rounded-lg border border-neutral-200 bg-white p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-3">
            <div className="h-6 w-56 animate-pulse rounded-md bg-neutral-200" />
            <div className="h-4 w-72 animate-pulse rounded-md bg-neutral-100" />
            <div className="h-3 w-24 animate-pulse rounded-md bg-neutral-100" />
          </div>
          <div className="h-10 w-32 animate-pulse rounded-md bg-neutral-200" />
        </div>
      </div>

      {/* Stat tiles skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-neutral-100" />
            <div className="mt-3 h-8 w-20 animate-pulse rounded bg-neutral-200" />
            <div className="mt-3 h-3 w-32 animate-pulse rounded bg-neutral-100" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div>
        <div className="mb-3 h-5 w-32 animate-pulse rounded bg-neutral-200" />
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-3">
            <div className="grid grid-cols-6 gap-4">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-3 w-16 animate-pulse rounded bg-neutral-200"
                />
              ))}
            </div>
          </div>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="grid grid-cols-6 gap-4 border-b border-neutral-100 px-4 py-4 last:border-b-0"
            >
              {[0, 1, 2, 3, 4, 5].map((col) => (
                <div
                  key={col}
                  className="h-4 animate-pulse rounded bg-neutral-100"
                  style={{ width: `${50 + (col % 3) * 15}%` }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
