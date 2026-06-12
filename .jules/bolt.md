## 2024-05-24 - Array.reduce bottlenecks
**Learning:** In multiple places across the codebase, there was a pattern of doing a full pass to group/aggregate items into a map, and then converting the map values to an array `Array.from(map.values())` and doing a full second O(N) iteration `reduce` pass over it just to sum a total. This double iteration overhead can be avoided by summing the total dynamically during the first pass while items are being grouped or evaluated.
**Action:** Always look to combine multiple sequential loop iterations (`reduce`, `map`, `filter`) or `Array.from()` array instantiations into single pass logic when calculating totals or manipulating collections.

## 2024-06-05 - Avoiding multiple array allocations with spread and filter/map
**Learning:** Found multiple instances where large arrays were allocated unnecessarily: chained `.filter().map()` calls, large array spreads `[...a, ...b, ...c]`, and full array allocations before early slicing `Array.from(map.values()).slice(0, N)`.
**Action:** Replace chained array functions with single `for...of` loops, sequence multi-array iterations with nested loops instead of spreading, and loop over iterators like `map.values()` to `break` early rather than allocating a full array then slicing.
## 2024-06-12 - [Array.from Native Optimization]
**Learning:** `Array.from` executes natively in V8 and is generally faster than manual `for...of` loops with `.push()`. Replacing `Array.from(iterable)` with a manual loop to "avoid intermediate arrays" is factually incorrect (as `Array.from` builds the result directly) and results in a de-optimization. When mapping is needed, `Array.from(iterable, mapFn)` avoids intermediate arrays while maintaining readability.
**Action:** Never replace simple `Array.from()` calls with manual loops. Use the mapping argument of `Array.from` instead of chaining `.map()` on the result.
