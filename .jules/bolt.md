## 2024-08-06 - Eliminate Array Spread in Math.min/max

**Learning:** Using array spread inside `Math.min()` and `Math.max()` (e.g., `Math.max(...array)`) over dynamically-sized arrays risks `RangeError: Maximum call stack size exceeded` in V8 due to argument length limits. When the array is generated via chained `.map().filter()`, it also incurs unnecessary memory overhead.
**Action:** Replace `Math.max(...array)` with `array.reduce((max, val) => Math.max(max, val), -Infinity)`. Replace `Math.min(...array)` with `array.reduce((min, val) => Math.min(min, val), Infinity)`. This combines traversal and evaluation into a single pass and inherently prevents call stack overflows.
