## 2024-05-24 - Array.reduce bottlenecks
**Learning:** In multiple places across the codebase, there was a pattern of doing a full pass to group/aggregate items into a map, and then converting the map values to an array `Array.from(map.values())` and doing a full second O(N) iteration `reduce` pass over it just to sum a total. This double iteration overhead can be avoided by summing the total dynamically during the first pass while items are being grouped or evaluated.
**Action:** Always look to combine multiple sequential loop iterations (`reduce`, `map`, `filter`) or `Array.from()` array instantiations into single pass logic when calculating totals or manipulating collections.

## 2024-06-05 - Avoiding multiple array allocations with spread and filter/map
**Learning:** Found multiple instances where large arrays were allocated unnecessarily: chained `.filter().map()` calls, large array spreads `[...a, ...b, ...c]`, and full array allocations before early slicing `Array.from(map.values()).slice(0, N)`.
**Action:** Replace chained array functions with single `for...of` loops, sequence multi-array iterations with nested loops instead of spreading, and loop over iterators like `map.values()` to `break` early rather than allocating a full array then slicing.

## 2024-06-21 - Array.from mapFn vs chained map
**Learning:** `Array.from(iterable).map(mapFn)` is an anti-pattern that creates two arrays (one for `from`, one for `map`) and loops twice. Using the built-in mapFn argument `Array.from(iterable, mapFn)` achieves the same result with half the allocations and iterations.
**Action:** Always prefer the mapFn argument of `Array.from` when mapping iterables to an array. Apply the same logic to `.filter()` by converting to a `for...of` loop when dealing with iterables to prevent intermediate array allocation.

## 2026-06-23 - Eliminating unnecessary chained filter-map logic
**Learning:** We continue to observe chained array iteration functions (like `.filter(fn1).map(fn2)`) causing significant memory overhead by creating intermediate arrays.
**Action:** Found instances in analytical/reporting data structures (`src/reports/executive/builder.ts`) mapping through comparisons and drivers. Rewriting these functions using a single-pass `for...of` loop skips creating extra arrays for `.filter()` allowing items to be processed immediately. Keep hunting for chained `.filter().map()` calls.

## 2026-11-01 - Playwright link ambiguity due to overly broad regex
**Learning:** In Playwright E2E tests, using a non-exact regex like `/log in/i` to find a link (e.g., `page.getByRole('link', { name: /log in/i })`) can accidentally match completely unintended elements if the regex is a substring of their name. For example, if there is a link named "Login" and another link, or some text that contains "log in", Playwright might click the wrong link or throw a strict mode error if multiple matches occur.
**Action:** When selecting links with generic names like "Log in", always use an exact string match (e.g., `name: 'Log in', exact: true`) to guarantee Playwright selects the correct element and doesn't get confused by substrings elsewhere on the page.

## 2026-11-01 - Preventing Edge Runtime Environment Validation Failures
**Learning:** In Next.js, routes evaluated in the Edge runtime do not have access to Node.js `process.env` in the same way as the standard Node.js runtime. If a route imports a module (like `@supabase/supabase-js`) that uses Node.js APIs or relies on strict environment variable validation (like `src/env.ts`) that expects `process.env`, the Edge runtime evaluation during build can fail with missing environment variables (e.g. `Invalid environment variables: Required`).
**Action:** When a Next.js route uses Node.js-specific imports or relies on `src/env.ts` validation that fails in the Edge runtime during static generation or build, explicitly declare `export const runtime = 'nodejs';` at the top of the route file to ensure it's evaluated in the proper runtime context.
