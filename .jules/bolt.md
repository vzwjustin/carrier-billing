## 2024-05-24 - Array.reduce bottlenecks
**Learning:** In multiple places across the codebase, there was a pattern of doing a full pass to group/aggregate items into a map, and then converting the map values to an array `Array.from(map.values())` and doing a full second O(N) iteration `reduce` pass over it just to sum a total. This double iteration overhead can be avoided by summing the total dynamically during the first pass while items are being grouped or evaluated.
**Action:** Always look to combine multiple sequential loop iterations (`reduce`, `map`, `filter`) or `Array.from()` array instantiations into single pass logic when calculating totals or manipulating collections.

## 2024-06-05 - Avoiding multiple array allocations with spread and filter/map
**Learning:** Found multiple instances where large arrays were allocated unnecessarily: chained `.filter().map()` calls, large array spreads `[...a, ...b, ...c]`, and full array allocations before early slicing `Array.from(map.values()).slice(0, N)`.
**Action:** Replace chained array functions with single `for...of` loops, sequence multi-array iterations with nested loops instead of spreading, and loop over iterators like `map.values()` to `break` early rather than allocating a full array then slicing.

## 2024-11-20 - Sequential O(N) chains over same array
**Learning:** Found multiple places using chained  on the same `drivers` array (up to 3 times) to calculate sums. This allocates temporary arrays and needlessly repeats full array passes.
**Action:** Use a single `for...of` loop instead when multiple aggregates or groupings need to be accumulated from a single array.

## 2024-11-20 - Sequential O(N) chains over same array
**Learning:** Found multiple places using chained filter/reduce on the same `drivers` array (up to 3 times) to calculate sums. This allocates temporary arrays and needlessly repeats full array passes.
**Action:** Use a single `for...of` loop instead when multiple aggregates or groupings need to be accumulated from a single array.
