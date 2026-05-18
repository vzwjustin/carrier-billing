'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  THEME_STORAGE_KEY,
  resolvePreference,
  type ThemePreference,
} from '@/lib/theme';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

declare global {
  interface Window {
    __applyTheme?: () => void;
  }
}

export function ThemeToggle(): React.JSX.Element {
  const [pref, setPref] = useState<ThemePreference>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      setPref(resolvePreference(localStorage.getItem(THEME_STORAGE_KEY)));
    } catch {
      /* localStorage unavailable — keep default */
    }
  }, []);

  function select(next: ThemePreference): void {
    setPref(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* ignore persistence failure */
    }
    window.__applyTheme?.();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex items-center rounded-full border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900"
    >
      {OPTIONS.map((opt) => {
        const active = mounted && pref === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => select(opt.value)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
