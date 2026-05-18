export const THEME_STORAGE_KEY = 'carrieraudit-theme';

export type ThemePreference = 'light' | 'dark' | 'system';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolvePreference(value: string | null): ThemePreference {
  return isThemePreference(value) ? value : 'system';
}
