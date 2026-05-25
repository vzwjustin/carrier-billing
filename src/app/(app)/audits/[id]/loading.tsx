export default function AuditDetailLoading() {
  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="h-4 w-44 animate-pulse rounded bg-muted" />

      {/* Hero: status + savings */}
      <div className="rounded-2xl border bg-card p-8 shadow-sm space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
          <div className="h-4 w-32 animate-pulse rounded bg-muted/70" />
        </div>
        <div className="h-10 w-72 animate-pulse rounded bg-muted" />
        <div className="h-4 w-80 animate-pulse rounded bg-muted/70" />
      </div>

      {/* Stats row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border bg-card p-5 shadow-sm space-y-2"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="h-7 w-20 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <div className="h-10 w-40 animate-pulse rounded-lg bg-muted" />
        <div className="h-10 w-32 animate-pulse rounded-lg bg-muted" />
      </div>

      {/* Findings */}
      <div className="space-y-4">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border bg-card p-6 shadow-sm space-y-3"
          >
            <div className="flex justify-between">
              <div className="h-5 w-72 animate-pulse rounded bg-muted" />
              <div className="h-5 w-20 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-4 w-full animate-pulse rounded bg-muted/70" />
          </div>
        ))}
      </div>

      <p className="sr-only">Loading audit details…</p>
    </div>
  );
}
