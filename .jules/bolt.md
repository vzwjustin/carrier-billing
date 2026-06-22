## 2024-05-24 - Array.reduce bottlenecks
**Learning:** In multiple places across the codebase, there was a pattern of doing a full pass to group/aggregate items into a map, and then converting the map values to an array `Array.from(map.values())` and doing a full second O(N) iteration `reduce` pass over it just to sum a total. This double iteration overhead can be avoided by summing the total dynamically during the first pass while items are being grouped or evaluated.
**Action:** Always look to combine multiple sequential loop iterations (`reduce`, `map`, `filter`) or `Array.from()` array instantiations into single pass logic when calculating totals or manipulating collections.

## 2024-06-05 - Avoiding multiple array allocations with spread and filter/map
**Learning:** Found multiple instances where large arrays were allocated unnecessarily: chained `.filter().map()` calls, large array spreads `[...a, ...b, ...c]`, and full array allocations before early slicing `Array.from(map.values()).slice(0, N)`.
**Action:** Replace chained array functions with single `for...of` loops, sequence multi-array iterations with nested loops instead of spreading, and loop over iterators like `map.values()` to `break` early rather than allocating a full array then slicing.

## 2024-06-21 - Array.from mapFn vs chained map
**Learning:** `Array.from(iterable).map(mapFn)` is an anti-pattern that creates two arrays (one for `from`, one for `map`) and loops twice. Using the built-in mapFn argument `Array.from(iterable, mapFn)` achieves the same result with half the allocations and iterations.
**Action:** Always prefer the mapFn argument of `Array.from` when mapping iterables to an array. Apply the same logic to `.filter()` by converting to a `for...of` loop when dealing with iterables to prevent intermediate array allocation.

## 2024-07-28 - Multiple array filter/reduce loops over same dataset
**Learning:** Found an anti-pattern in metric aggregation where a large array is iterated over multiple times using chained `.filter().reduce()` for different metric categories. This increases algorithmic time complexity and creates intermediate filtered array allocations unnecessarily.
**Action:** When calculating multiple aggregate metrics or grouping from a single collection, consolidate the calculations into a single pass (like a `for...of` loop) to avoid multiple full O(N) passes and redundant intermediate arrays.

## 2024-07-28 - Build failing on production build Next JS server environment validation
**Learning:** For Next.js builds on environments (like Vercel/Netlify builds or CI), if a build requires a Supabase client (`createBrowserClient` or `createServerClient`) inside files evaluated at build time (e.g. `src/middleware.ts` or Layouts rendering the SiteNav which indirectly evaluate auth contexts) and the environment variables are not injected (since `.env.local` is ignored in CI and production secrets aren't available), Zod schema validations triggered in `src/env.ts` will crash the build with "Invalid environment variables".
**Action:** When working on components that get statically rendered or imported at build-time, ensure you aren't removing or changing `SKIP_ENV_VALIDATION` checks or causing early evaluation of strictly validated ENV keys in files evaluated by `next build`.
