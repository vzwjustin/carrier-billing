## 2024-05-24 - V8 Call Stack limits and Spread Operator
**Learning:** Using the spread operator (`...`) on potentially large arrays within functions like `Math.max()` can lead to V8's "Maximum call stack size exceeded" error. In rules processing potentially thousands of lines or features, this is a real risk.
**Action:** Replace `Math.max(...array.map())` and chained `.map().filter()` operations on unbounded data with `.reduce()` or single-pass `for` loops. Always remember to seed `Math.max` reductions with `-Infinity` and `Math.min` with `Infinity` to handle empty arrays gracefully.

## 2024-05-24 - Cloudflare Pages CI missing ENV
**Learning:** Cloudflare Pages builds use `CF_PAGES=1`, which can break Next.js server-side static generation if components like Inngest routes perform required env variable validation (e.g., `INNGEST_SIGNING_KEY`).
**Action:** When validating server-side secrets in Next.js API routes or `src/env.ts` during builds, ensure to explicitly bypass the checks if `process.env.CF_PAGES === '1'`.
