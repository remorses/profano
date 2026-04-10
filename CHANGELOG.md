# Changelog

## 0.0.3

1. **Fixed `%Total` exceeding 100%** — on real profiles with recursive functions (React reconciler, fiber tree walks, deeply nested calls), `%Total` could show nonsense values like `462.3%` because the same function identity was counted once per profiler tree node per sample instead of once per sample. V8's cpuprofile creates a separate tree node per distinct call site, so a function like `updateFiberRecursively` appears as multiple nodes with identical `callFrame` — profano now dedupes by function identity during the stack walk so every identity contributes at most 1 to the total count per sample. The invariant `%Total <= 100%` is now enforced by tests.

   Example from a real react.dev profile (480 active samples):

   ```
   Before:  updateFiberRecursively   2219 samples   462.3% total
   After:   updateFiberRecursively    102 samples    21.3% total
   ```

   The `%Self` column was already correct in previous versions and is unchanged.

2. **Added vitest regression tests** — `src/parse.test.ts` covers the recursive-function bug, the self/total ≤ 100% invariant, idle-frame exclusion, and `nonIdleSamples` calculation. Run with `pnpm test`.

## 0.0.2

1. **Added `--sort` option** — sort results by self-time (default) or total/inclusive time:

   ```bash
   # sort by total/inclusive time to find expensive callers
   profano profile.cpuprofile --sort total

   # sort by self-time to find hot inner functions (default)
   profano profile.cpuprofile --sort self
   ```

2. **New Total and %Total columns** — the output table now shows both self-time and total (inclusive) time per function, with percentages calculated against non-idle active samples:

   ```
      Self  %Self    Total  %Total  Function                        Location
   ───────  ──────  ───────  ──────  ──────────────────────────────  ────────────────────
      3402   29.5%    6804   58.9%  parseAsync                      src/parser.ts:142
   ```

3. **AI agent skill** — profano now ships a `skills/profano/SKILL.md` that teaches AI coding agents (Claude Code, Cursor, Windsurf) when and how to CPU profile JS/TS programs. Install it with:

   ```bash
   npx -y skills add remorses/profano
   ```

## 0.0.1

Initial release. Self-time table from V8 `.cpuprofile` files in the terminal.
