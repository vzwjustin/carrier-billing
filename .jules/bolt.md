## 2024-05-17 - V8 Call Stack Limits with Spread Operators

**Learning:** Using the spread operator (`...`) with `Math.max()` or `Math.min()` on dynamically sized arrays can cause `RangeError: Maximum call stack size exceeded` in V8 environments because the array elements are spread into individual function arguments. In edge runtimes or CI builds, this can cause failures even with moderately sized arrays.

**Action:** Always replace `Math.max(...array)` and `Math.min(...array)` with `.reduce()` or a traditional `for...of` loop when the array's maximum size cannot be guaranteed to be extremely small at compile time.
