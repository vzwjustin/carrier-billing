import { cn } from '@/lib/utils';
import {
  ROADMAP,
  overallStats,
  sectionStats,
  type RoadmapStats,
} from '@/lib/roadmap/data';

export const metadata = {
  title: 'Roadmap — CarrierAudit',
};

function ProgressBar({
  stats,
  className,
}: {
  stats: RoadmapStats;
  className?: string;
}): React.JSX.Element {
  const complete = stats.done === stats.total && stats.total > 0;
  return (
    <div
      className={cn(
        'h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800',
        className,
      )}
      role="progressbar"
      aria-valuenow={stats.pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${stats.done} of ${stats.total} complete`}
    >
      <div
        className={cn(
          'h-full rounded-full transition-all',
          complete ? 'bg-emerald-500' : 'bg-blue-500',
        )}
        style={{ width: `${stats.pct}%` }}
      />
    </div>
  );
}

export default function RoadmapPage(): React.JSX.Element {
  const overall = overallStats();

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
              Project Roadmap
            </h1>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Ingested from the CarrierAudit project TODO — {ROADMAP.length}{' '}
              sections, {overall.total} items.
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
              {overall.pct}%
            </div>
            <div className="text-xs text-neutral-500 dark:text-neutral-500">
              {overall.done} done · {overall.pending} pending
            </div>
          </div>
        </div>
        <ProgressBar stats={overall} className="h-3" />
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        {ROADMAP.map((section) => {
          const stats = sectionStats(section);
          return (
            <section
              key={section.title}
              className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {section.title}
                </h2>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
                    stats.done === stats.total && stats.total > 0
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
                  )}
                >
                  {stats.done}/{stats.total}
                </span>
              </div>
              <ProgressBar stats={stats} className="mt-3" />
              <ul className="mt-4 space-y-2">
                {section.items.map((item) => (
                  <li
                    key={item.label}
                    className="flex items-start gap-2.5 text-sm"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold',
                        item.done
                          ? 'border-emerald-500 bg-emerald-500 text-white'
                          : 'border-neutral-300 bg-white text-transparent dark:border-neutral-600 dark:bg-neutral-800',
                      )}
                    >
                      ✓
                    </span>
                    <span
                      className={cn(
                        item.done
                          ? 'text-neutral-400 line-through dark:text-neutral-600'
                          : 'text-neutral-800 dark:text-neutral-200',
                      )}
                    >
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
