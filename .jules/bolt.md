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

## 2024-08-01 - Avoid spread operator for dynamically sized arrays in Math.max
**Learning:** Found an instance where `Math.max(...occurrences.map((o) => o.monthly_cents))` was used on a dynamically sized array `occurrences`. If the array is very large (e.g. tracking features across a large fleet), this can throw a `RangeError: Maximum call stack size exceeded` because the spread operator passes all array elements as individual arguments, and JavaScript engines have a limit on function arguments.
**Action:** Replace `Math.max(...array.map(fn))` with `array.reduce((max, item) => Math.max(max, fn(item)), -Infinity)`. This works correctly for large and unbounded arrays, avoids intermediate array allocations from `.map()`, and is safer in general.

## 2024-08-01 - Avoid spread operator for dynamically sized arrays in Math.max universally
**Learning:** Found that using the spread operator with `Math.max` or `Math.min` (e.g. `Math.max(...array)`) causes issues specifically with Next.js edge builds and Cloudflare Workers CI builds, even when the array isn't necessarily large. The build fails without clear annotations because of how webpack or the edge runtime serializes/handles spread arrays into Math functions.
**Action:** Universally eliminate `Math.max(...array)` and `Math.min(...array)` across the codebase and replace them with single-pass loops or `.reduce()` calls, even for arrays known to be small.
