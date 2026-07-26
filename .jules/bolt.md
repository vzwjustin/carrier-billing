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
## 2024-07-26 - Spread operator RangeError in Math.max
**Learning:** Found an instance in `src/rules/definitions/feature-appears-on-majority-of-lines-under-one-dollar.ts` where a potentially massive, fleet-wide array was spread into `Math.max(...occurrences.map(o => o.monthly_cents))`. In V8, spreading dynamically sized arrays can quickly throw a `RangeError: Maximum call stack size exceeded` and crash the application.
**Action:** Replace `Math.max(...array)` with a `for...of` loop tracking the maximum manually (or `.reduce()` if iterating once) on arrays that can dynamically scale with account sizes to avoid stack limit bugs.

## 2024-07-26 - Export route Edge runtime crash
**Learning:** Found that `src/app/(app)/admin/export/route.ts` imported `@supabase/supabase-js` via `src/lib/supabase/admin.ts`. The route was deployed to the Edge Runtime (or at least had no runtime explicitly configured), which caused a Next.js build error: "A Node.js API is used (process.version at line: 27) which is not supported in the Edge Runtime". The admin supabase client is used here, and `supabase-js` relies on `process.version` which isn't available in edge functions.
**Action:** When a Next.js App Router API route uses `@supabase/supabase-js` (e.g., via the admin client) rather than `@supabase/ssr`, ensure `export const runtime = 'nodejs';` is set at the top of the route file to prevent Edge runtime crashes.
