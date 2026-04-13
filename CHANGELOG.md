# Changelog

## 0.1.0

1. **New `Self ms` and `Total ms` columns** — the table now shows real millisecond timings for every function, computed by summing `timeDeltas` from the `.cpuprofile` file. No more guessing from sample counts:

   ```
      Self  %Self   Self ms    Total  %Total  Total ms  Function              Location
   ───────  ──────  ───────  ───────  ──────  ────────  ────────────────────  ────────────
        10    6.0%   10.6ms       10    6.0%    10.6ms  measureHostInstance   installHook.js:0
        28   16.9%   0.70ms       31   18.7%     3.1ms  commitMutation...     react-dom_client.js:7234
   ```

   When `timeDeltas` is missing from the profile, falls back to `(endTime - startTime) / samples.length` as the average delta per sample.

2. **Sorting now uses milliseconds, not sample counts** — `--sort self` and `--sort total` rank by actual time. This fixes incorrect rankings when sampling intervals are non-uniform (e.g. a function with 10 samples at 10.6ms now correctly ranks above one with 28 samples at 0.70ms). Sample count is used as tiebreaker.

3. **React component profiling workflow** — the profano skill (`skills/profano/SKILL.md`) now documents how to profile React 19.2+ component renders in the browser using playwriter + `PerformanceObserver`, convert the data to `.cpuprofile`, and analyze with profano to find the slowest components.

## 0.0.5

1. **Fixed two function-identity bugs** — the identity used to group profile samples into one row per function was too weak, so different functions were silently merged into a single row on real profiles. Both issues were flagged by an oracle code review against Chrome DevTools and speedscope's own identity rules.

   **Missing `columnNumber` and `scriptId`.** Chrome DevTools uses `functionName@scriptId:lineNumber:columnNumber` as its identity key (`ProfileTreeModel.ts:21`) and speedscope uses `name:file:line:col` (`src/import/chrome.ts:206-212`). profano was using only `functionName|url|lineNumber`, which merges:

   - different anonymous functions on the same minified line (very common in `bundle.js:0` where dozens of functions share one logical line)
   - two different loaded copies of the same script (iframes, sandboxes, VM scripts)

   After the fix, profano's identity is `(functionName, scriptId, lineNumber, columnNumber)` — matching DevTools. On the react.dev browser profile used to validate the `0.0.3` fix, the number of distinct function rows went from ~417 to ~492, and the former top `(anonymous)` row that claimed `756 total samples` is now correctly split into multiple distinct entries, the largest showing `247 samples / 51.5%`.

   **Unsafe `key.split('|')`.** profano built the identity key by concatenating fields with `|` and later parsed it back with `key.split('|')`. That is lossy — a function literally named `a|b|c` would round-trip to `functionName: "a"`, `url: "b"`, `lineNumber: NaN`. Fix: the identity key is now `JSON.stringify([functionName, scriptId, lineNumber, columnNumber])` (delimiter-safe by construction) and the full metadata is stored in a side `Map<string, IdentityMeta>` so profano never has to parse the key back at all.

2. **`FunctionStat` now exposes `scriptId` and `columnNumber`** — the aggregated rows returned by `analyze()` carry the full location info from the source `callFrame`, not just `functionName`, `url`, and `lineNumber`. This is a type-level addition and does not change the default CLI output.

3. **Cached identity per node id** — the identity key and metadata are computed once per profile node in a single pre-pass and looked up from a `Map<number, { key, meta }>` inside the hot ancestor-walk loop. Previously the key was rebuilt on every ancestor visit (N samples × D stack depth), which was a minor perf hit on large profiles.

4. **Added 5 regression tests** covering the new edge cases (`src/parse.test.ts` — 9 tests total now):

   - same `functionName/url/line`, different **column** → distinct rows
   - same `functionName/url/line/column`, different **scriptId** → distinct rows
   - `functionName` containing `|` → round-trips correctly
   - leaf `foo` + ancestor `foo` in the same sample → `selfSamples=3` AND `totalSamples=3`
   - empty `samples` array → no crash, empty result

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
