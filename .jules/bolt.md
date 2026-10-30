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

## 2024-05-29 - O(N^2) allocations in nested filters
**Learning:** Using chained `.map().filter()` inside a nested loop where the parent collection is filtered again (e.g. `const peers = phones.filter((p) => p.lineIndex !== lineIndex); const peerCosts = peers.map()`) creates unnecessary O(N^2) array allocations and redundantly recalculates items repeatedly.
**Action:** Replace the initial `.map().filter()` with a single-pass `for` loop that precomputes and caches required properties. For the inner loop, iterate directly over the cached array and build the nested collection without intermediate `.filter()` allocations.
