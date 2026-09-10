## 2024-05-24 - V8 Call Stack limits and Spread Operator
**Learning:** Using the spread operator (`...`) on potentially large arrays within functions like `Math.max()` can lead to V8's "Maximum call stack size exceeded" error. In rules processing potentially thousands of lines or features, this is a real risk.
**Action:** Replace `Math.max(...array.map())` and chained `.map().filter()` operations on unbounded data with `.reduce()` or single-pass `for` loops. Always remember to seed `Math.max` reductions with `-Infinity` and `Math.min` with `Infinity` to handle empty arrays gracefully.
