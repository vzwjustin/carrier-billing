// Skeleton shown while loading a public share page. Matches the rough
// shape of `audit-viewer.tsx` so layout doesn't shift when the real
// content streams in.
export default function ShareLoading() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="space-y-8">
        {/* Hero: savings number */}
        <div className="rounded-2xl border bg-card p-8 shadow-sm">
          <div className="space-y-4">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-12 w-56 animate-pulse rounded bg-muted" />
            <div className="h-4 w-72 animate-pulse rounded bg-muted/70" />
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border bg-card p-5 shadow-sm space-y-2"
            >
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
              <div className="h-8 w-24 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>

        {/* Finding cards */}
        <div className="space-y-4">
          <div className="h-6 w-44 animate-pulse rounded bg-muted" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border bg-card p-6 shadow-sm space-y-3"
            >
              <div className="flex items-start justify-between">
                <div className="h-5 w-72 animate-pulse rounded bg-muted" />
                <div className="h-5 w-24 animate-pulse rounded bg-muted" />
              </div>
              <div className="h-4 w-full animate-pulse rounded bg-muted/70" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-muted/70" />
            </div>
          ))}
        </div>
      </div>
      <p className="sr-only">Loading audit report…</p>
    </div>
  );
}
