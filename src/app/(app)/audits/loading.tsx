// Loading skeleton for the audits list. Match the structure of
// `src/app/(app)/audits/page.tsx` so layout doesn't jump.
export default function AuditsListLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <div className="h-8 w-44 animate-pulse rounded bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded bg-muted/70" />
        </div>
        <div className="h-10 w-32 animate-pulse rounded-lg bg-muted" />
      </div>

      <div className="rounded-xl border bg-card shadow-sm">
        <div className="divide-y">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 animate-pulse rounded-lg bg-muted" />
                <div className="space-y-2">
                  <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-28 animate-pulse rounded bg-muted/70" />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="h-6 w-24 animate-pulse rounded-full bg-muted/70" />
                <div className="h-6 w-20 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="sr-only">Loading audits…</p>
    </div>
  );
}
