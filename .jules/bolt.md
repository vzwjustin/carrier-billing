## 2024-05-24 - Array.reduce bottlenecks
**Learning:** In multiple places across the codebase, there was a pattern of doing a full pass to group/aggregate items into a map, and then converting the map values to an array `Array.from(map.values())` and doing a full second O(N) iteration `reduce` pass over it just to sum a total. This double iteration overhead can be avoided by summing the total dynamically during the first pass while items are being grouped or evaluated.
**Action:** Always look to combine multiple sequential loop iterations (`reduce`, `map`, `filter`) or `Array.from()` array instantiations into single pass logic when calculating totals or manipulating collections.

## 2024-06-05 - Avoiding multiple array allocations with spread and filter/map
**Learning:** Found multiple instances where large arrays were allocated unnecessarily: chained `.filter().map()` calls, large array spreads `[...a, ...b, ...c]`, and full array allocations before early slicing `Array.from(map.values()).slice(0, N)`.
**Action:** Replace chained array functions with single `for...of` loops, sequence multi-array iterations with nested loops instead of spreading, and loop over iterators like `map.values()` to `break` early rather than allocating a full array then slicing.
## 2024-06-12 - Eliminate N+1 DB query in cleanup-orphan-audits
**Learning:** Chained `.filter().reduce()` operations inside a database read loop degrade performance, particularly when paired with an N+1 query loop. The database latency is `2N` round trips rather than `N+1` when sequentially looping to pull dependent row values.
**Action:** When gathering related data for multiple primary keys (e.g., findings for multiple audit IDs), use `in()` to bulk-fetch the related data, group it in memory via a Map or dictionary, and compute logic in a single-pass loop (like `for...of`).
