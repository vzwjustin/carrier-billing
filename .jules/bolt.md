## 2024-05-24 - Array.reduce bottlenecks
**Learning:** In multiple places across the codebase, there was a pattern of doing a full pass to group/aggregate items into a map, and then converting the map values to an array `Array.from(map.values())` and doing a full second O(N) iteration `reduce` pass over it just to sum a total. This double iteration overhead can be avoided by summing the total dynamically during the first pass while items are being grouped or evaluated.
**Action:** Always look to combine multiple sequential loop iterations (`reduce`, `map`, `filter`) or `Array.from()` array instantiations into single pass logic when calculating totals or manipulating collections.

## 2024-06-05 - Avoiding multiple array allocations with spread and filter/map
**Learning:** Found multiple instances where large arrays were allocated unnecessarily: chained `.filter().map()` calls, large array spreads `[...a, ...b, ...c]`, and full array allocations before early slicing `Array.from(map.values()).slice(0, N)`.
**Action:** Replace chained array functions with single `for...of` loops, sequence multi-array iterations with nested loops instead of spreading, and loop over iterators like `map.values()` to `break` early rather than allocating a full array then slicing.
## 2025-01-16 - Avoid multiple array allocations by preferring mapFn with Array.from() and using reduce() or for..of over .map().filter() chained calls
**Learning:** In multiple places across the codebase, chained array methods like `.filter().map()` or `Array.from().map()` are used. This causes intermediate arrays to be allocated which increases memory usage and GC pauses.
**Action:** Replace `Array.from(iter).map()` with `Array.from(iter, mapFn)`. Replace `.filter().map()` chains and `.map().filter()` chains with a single `.reduce()` or `for...of` loop. Merge `.filter().reduce()` chains iterating over the same arrays into a single `for...of` pass.
