import { THEME_STORAGE_KEY } from '@/lib/theme';

// Runs before paint to set data-theme from the stored preference (resolving
// "system" via matchMedia) so there is no flash of the wrong theme. Also
// installs a live listener so "system" tracks OS changes without a reload.
const SCRIPT = `
(function () {
  try {
    var KEY = ${JSON.stringify(THEME_STORAGE_KEY)};
    var root = document.documentElement;
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    function pref() {
      var v = null;
      try { v = localStorage.getItem(KEY); } catch (e) {}
      return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
    }
    function apply() {
      var p = pref();
      var resolved = p === 'system' ? (mql.matches ? 'dark' : 'light') : p;
      root.setAttribute('data-theme', resolved);
    }
    apply();
    if (mql.addEventListener) {
      mql.addEventListener('change', function () {
        if (pref() === 'system') apply();
      });
    }
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) apply();
    });
    window.__applyTheme = apply;
  } catch (e) {}
})();
`;

export function ThemeScript(): React.JSX.Element {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
