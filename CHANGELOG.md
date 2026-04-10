# Changelog

## 0.0.4

1. **Fixed multi-file analysis** — passing multiple `.cpuprofile` files as positional args previously showed a table for only the FIRST file, silently ignoring the rest. Cause: the command signature was `<files...>`, which goke parsed as a single required arg named `files...` (literal, trailing dots) instead of a variadic arg, because goke's variadic parser specifically looks for `...` at the **start** of the bracket content (`[...files]`), not the end. Switched the signature to `[...files]` so `profano a.cpuprofile b.cpuprofile c.cpuprofile` now renders all three tables with the `━━━` header separator between them.

   ```bash
   # Now actually analyzes both files instead of silently dropping the second
   profano tmp/cpu-profiles/*.cpuprofile
   ```

2. **Rewrote `--help` output per the goke skill** — the command description is now a multi-paragraph block explaining inputs, what the tool does, and when to use `--sort self` vs `--sort total`. Option descriptions are more specific. The `(default: …)` text is no longer duplicated (goke appends it automatically from the Zod schema).

3. **Removed dead type-assertion workarounds** — the old code had `Array.isArray(files) ? files : [files]` and `options.sort as SortMode` as band-aids for the broken variadic. Both are gone now that the command signature is correct and option types are inferred from schemas.

4. **Added `vitest.config.ts`** scoped to `src/**/*.test.ts` so the published `dist/parse.test.js` isn't picked up as an extra test run.

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
