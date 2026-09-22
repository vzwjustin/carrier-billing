1. **Refactor array spreading in `src/rules/definitions/promo-credit-expires-before-device-payoff.ts`**
   - The current code uses `Math.max(...remainingTerms)` and `Math.min(...expiringCredits.map(...))` which allocates intermediate arrays and uses spread operator on dynamically-sized arrays, an anti-pattern noted in `.jules/bolt.md` and memories.
   - Refactor them to loop through the array to find min/max without allocating intermediate arrays or using the spread operator.
   - Example exact diff block:
     ```
     <<<<<<< SEARCH
             const remainingTerms = line.dpp_installments
               .map((d) => d.remaining_payments)
               .filter((n): n is number => n !== null && n > 0);
             if (remainingTerms.length === 0) return;
             const dppMonthsLeft = Math.max(...remainingTerms);
     =======
             let dppMonthsLeft = -Infinity;
             let hasRemaining = false;
             for (const d of line.dpp_installments) {
               if (d.remaining_payments !== null && d.remaining_payments > 0) {
                 hasRemaining = true;
                 if (d.remaining_payments > dppMonthsLeft) {
                   dppMonthsLeft = d.remaining_payments;
                 }
               }
             }
             if (!hasRemaining) return;
     >>>>>>> REPLACE
     ```
     and
     ```
     <<<<<<< SEARCH
             const soonestCyclesLeft = Math.min(
               ...expiringCredits.map((c) => creditCyclesLeft(c.expires_on as string)),
             );
     =======
             let soonestCyclesLeft = Infinity;
             for (const c of expiringCredits) {
               const cycles = creditCyclesLeft(c.expires_on as string);
               if (cycles < soonestCyclesLeft) soonestCyclesLeft = cycles;
             }
     >>>>>>> REPLACE
     ```

2. **Verify changes in `src/rules/definitions/promo-credit-expires-before-device-payoff.ts`**
   - Use `sed -n '40,95p' src/rules/definitions/promo-credit-expires-before-device-payoff.ts` to read the file and confirm the changes were applied correctly.

3. **Refactor array spreading in `src/rules/definitions/feature-appears-on-majority-of-lines-under-one-dollar.ts`**
   - The current code uses `Math.max(...occurrences.map((o) => o.monthly_cents))` which spreads a dynamically-sized mapped array.
   - Refactor to a reduce: `occurrences.reduce((max, o) => max > o.monthly_cents ? max : o.monthly_cents, -Infinity)`
   - Exact diff block:
     ```
     <<<<<<< SEARCH
                 total_monthly_cents: total,
                 per_line_max_cents: Math.max(...occurrences.map((o) => o.monthly_cents)),
               },
             });
     =======
                 total_monthly_cents: total,
                 per_line_max_cents: occurrences.reduce((max, o) => max > o.monthly_cents ? max : o.monthly_cents, -Infinity),
               },
             });
     >>>>>>> REPLACE
     ```

4. **Verify changes in `src/rules/definitions/feature-appears-on-majority-of-lines-under-one-dollar.ts`**
   - Use `sed -n '95,115p' src/rules/definitions/feature-appears-on-majority-of-lines-under-one-dollar.ts` to read the file and confirm the changes were applied correctly.

5. **Refactor array spreading in `src/app/(app)/inventory/[lineKey]/page.tsx`**
   - The code uses `Math.min(...baseValues)` and `Math.max(...baseValues)` where `baseValues` is obtained by chaining `.map().filter()`.
   - Refactor to single loop:
     ```
     <<<<<<< SEARCH
       // Sparkline-like spread for the plan-base over time (min/max/delta).
       const baseValues = history
         .map((h) => h.planBaseCents)
         .filter((v): v is number => typeof v === 'number');
       const minBase = baseValues.length > 0 ? Math.min(...baseValues) : null;
       const maxBase = baseValues.length > 0 ? Math.max(...baseValues) : null;
       const deltaCents =
         baseValues.length >= 2 && minBase !== null && maxBase !== null ? maxBase - minBase : null;
     =======
       // Sparkline-like spread for the plan-base over time (min/max/delta).
       let minBase: number | null = null;
       let maxBase: number | null = null;
       let validCount = 0;

       for (const h of history) {
         if (typeof h.planBaseCents === 'number') {
           validCount++;
           if (minBase === null || h.planBaseCents < minBase) minBase = h.planBaseCents;
           if (maxBase === null || h.planBaseCents > maxBase) maxBase = h.planBaseCents;
         }
       }

       const deltaCents =
         validCount >= 2 && minBase !== null && maxBase !== null ? maxBase - minBase : null;
     >>>>>>> REPLACE
     ```

6. **Verify changes in `src/app/(app)/inventory/[lineKey]/page.tsx`**
   - Use `sed -n '140,170p' "src/app/(app)/inventory/[lineKey]/page.tsx"` to read the file and confirm the changes were applied correctly.

7. **Run linters and tests**
   - Run `pnpm run lint` and `pnpm run test` (or `vitest run`) to verify all changes.

8. **Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.**
   - Run the pre commit tool.

9. **Create Pull Request**
   - Submit the PR with title "⚡ Bolt: [performance improvement] Remove array spreading for min/max calculations" and a description detailing What, Why, Impact, and Measurement.
