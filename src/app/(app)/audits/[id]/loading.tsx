export default function AuditDetailLoading() {
  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="bg-muted h-4 w-44 animate-pulse rounded" />

      {/* Hero: status + savings */}
      <div className="bg-card space-y-4 rounded-2xl border p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-muted h-6 w-24 animate-pulse rounded-full" />
          <div className="bg-muted/70 h-4 w-32 animate-pulse rounded" />
        </div>
        <div className="bg-muted h-10 w-72 animate-pulse rounded" />
        <div className="bg-muted/70 h-4 w-80 animate-pulse rounded" />
      </div>

      {/* Stats row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-card space-y-2 rounded-xl border p-5 shadow-sm">
            <div className="bg-muted h-3 w-24 animate-pulse rounded" />
            <div className="bg-muted h-7 w-20 animate-pulse rounded" />
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <div className="bg-muted h-10 w-40 animate-pulse rounded-lg" />
        <div className="bg-muted h-10 w-32 animate-pulse rounded-lg" />
      </div>

      {/* Findings */}
      <div className="space-y-4">
        <div className="bg-muted h-6 w-48 animate-pulse rounded" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card space-y-3 rounded-xl border p-6 shadow-sm">
            <div className="flex justify-between">
              <div className="bg-muted h-5 w-72 animate-pulse rounded" />
              <div className="bg-muted h-5 w-20 animate-pulse rounded" />
            </div>
            <div className="bg-muted/70 h-4 w-full animate-pulse rounded" />
          </div>
        ))}
      </div>

      <p className="sr-only">Loading audit details…</p>
    </div>
  );
}
