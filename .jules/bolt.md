## 2024-05-24 - Array.reduce bottlenecks
**Learning:** In multiple places across the codebase, there was a pattern of doing a full pass to group/aggregate items into a map, and then converting the map values to an array `Array.from(map.values())` and doing a full second O(N) iteration `reduce` pass over it just to sum a total. This double iteration overhead can be avoided by summing the total dynamically during the first pass while items are being grouped or evaluated.
**Action:** Always look to combine multiple sequential loop iterations (`reduce`, `map`, `filter`) or `Array.from()` array instantiations into single pass logic when calculating totals or manipulating collections.

## 2024-06-05 - Avoiding multiple array allocations with spread and filter/map
**Learning:** Found multiple instances where large arrays were allocated unnecessarily: chained `.filter().map()` calls, large array spreads `[...a, ...b, ...c]`, and full array allocations before early slicing `Array.from(map.values()).slice(0, N)`.
**Action:** Replace chained array functions with single `for...of` loops, sequence multi-array iterations with nested loops instead of spreading, and loop over iterators like `map.values()` to `break` early rather than allocating a full array then slicing.
## 2024-06-25 - Consolidating multiple chained array traversals
**Learning:** Found an instance in `src/autopsy/compare.ts` where multiple `.filter().reduce()` methods were chained, followed by a separate `.map()` equivalent `for...of` loop to aggregate metrics. This caused the script to iterate over the entire array four times, generating intermediate array allocations during each step.
**Action:** Replace multiple chained array iterations like `.filter().reduce()` with single `for...of` loops when aggregating variables to reduce traversal times from O(n * passes) to O(n).
