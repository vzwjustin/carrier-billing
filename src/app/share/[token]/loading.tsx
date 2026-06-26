// Skeleton shown while loading a public share page. Matches the rough
// shape of `audit-viewer.tsx` so layout doesn't shift when the real
// content streams in.
export default function ShareLoading() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="space-y-8">
        {/* Hero: savings number */}
        <div className="bg-card rounded-2xl border p-8 shadow-sm">
          <div className="space-y-4">
            <div className="bg-muted h-4 w-32 animate-pulse rounded" />
            <div className="bg-muted h-12 w-56 animate-pulse rounded" />
            <div className="bg-muted/70 h-4 w-72 animate-pulse rounded" />
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* ⚡ Bolt: Single-pass Array.from mapping avoids intermediate array instantiation */}
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="bg-card space-y-2 rounded-xl border p-5 shadow-sm">
              <div className="bg-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-muted h-8 w-24 animate-pulse rounded" />
            </div>
          ))}
        </div>

        {/* Finding cards */}
        <div className="space-y-4">
          <div className="bg-muted h-6 w-44 animate-pulse rounded" />
          {/* ⚡ Bolt: Single-pass Array.from mapping avoids intermediate array instantiation */}
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="bg-card space-y-3 rounded-xl border p-6 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="bg-muted h-5 w-72 animate-pulse rounded" />
                <div className="bg-muted h-5 w-24 animate-pulse rounded" />
              </div>
              <div className="bg-muted/70 h-4 w-full animate-pulse rounded" />
              <div className="bg-muted/70 h-4 w-5/6 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
      <p className="sr-only">Loading audit report…</p>
    </div>
  );
}
