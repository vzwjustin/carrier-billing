## 2024-05-19 - V8 Call Stack Exhaustion from Array Spread

**Learning:** In rules operating on enterprise accounts (which can contain >100,000 lines), using the spread operator on mapped properties (e.g., `Math.max(...occurrences.map(o => o.cents))`) will crash the V8 engine with a `RangeError: Maximum call stack size exceeded` because the array is unpacked into >100,000 function arguments, exceeding V8's ~10k argument limit.
**Action:** Always process large dataset aggregations using `Array.prototype.reduce()` (e.g., `occurrences.reduce((max, o) => Math.max(max, o.cents), -Infinity)`) rather than spreading into `Math.max()` or `Math.min()`. Ensure the initial accumulator for `.reduce()` correctly matches the mathematical neutral element (`-Infinity` for `max`, `Infinity` for `min`).
