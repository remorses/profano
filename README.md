# profano

CLI tool to analyze V8 `.cpuprofile` files and print the top functions by self-time or total-time directly in the terminal. Built for AI agents and humans who want quick profiling insights without opening Chrome DevTools.

## Install

```bash
npm install -g profano
```

Or run on demand:

```bash
npx profano profile.cpuprofile
```

## Agent Skill

profano ships with a skill file that teaches AI coding agents when and how to use it. Install it with:

```bash
npx -y skills add remorses/profano
```

This installs [skills](https://skills.sh) for AI coding agents like Claude Code, Cursor, Windsurf, and others. The skill lives at `skills/profano/SKILL.md` in this repo.

## Usage

```bash
# Analyze a profile, sorted by self-time (default)
profano ./tmp/cpu-profiles/CPU.*.cpuprofile

# Sort by total/inclusive time instead
profano profile.cpuprofile --sort total

# Show the top 50 functions (default 30)
profano profile.cpuprofile -n 50
```

Globs are expanded automatically, so you can pass multiple profiles at once.

Always run `profano --help` to see all options and more examples.

## Output

```
Duration: 12.34s
Samples:  11542 active / 12340 total (6.4% idle)
Sort:     self

   Self  %Self    Total  %Total  Function                                    Location
───────  ──────  ───────  ──────  ──────────────────────────────────────────  ────────────────────────────────
   3402   29.5%    6804   58.9%  parseAsync                                  src/parser.ts:142
   ...
```

- **Self** — samples where the function was at the top of the stack (exclusive time).
- **Total** — samples where the function appeared anywhere in the stack (inclusive time).
- **%Self / %Total** — percent of **non-idle** active samples, so you can see real hotspots even if the profile is mostly idle.

Idle, GC, and VM pseudo-frames (`(idle)`, `(garbage collector)`, `(program)`, `(root)`) are excluded from the function list so they don't drown out real code.

Start with `--sort self` to find CPU-bound leaves (hot inner functions). Switch to `--sort total` to find expensive callers that dominate wall time.

## Generating .cpuprofile files

### Node.js

Node has a built-in CPU profiler. Pass `--cpu-prof` when running a script and it writes a `.cpuprofile` file to the `--cpu-prof-dir` directory on exit:

```bash
node --cpu-prof --cpu-prof-dir=./tmp/cpu-profiles ./script.js
profano ./tmp/cpu-profiles/CPU.*.cpuprofile
```

Node writes the profile on **normal process exit**. You do not need a custom signal handler — Node flushes the profile automatically when the process exits on `SIGINT` (`Ctrl+C`) or `SIGTERM` (`kill <pid>`). `SIGKILL` (`kill -9`) skips the flush because the kernel terminates the process before Node gets a chance to run, so never use `kill -9` on a process you want to profile.

### NODE_OPTIONS for wrappers (pnpm, vite, tsx, next, …)

Anything that ultimately spawns `node` respects the `NODE_OPTIONS` env var. Use it when you cannot pass `--cpu-prof` directly to `node` — for example `pnpm dev`, `vite`, `tsx`, `next dev`, `nest start`, a package.json script, or a CI step:

```bash
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=./tmp/cpu-profiles" pnpm dev
# reproduce the slow path...
# then Ctrl+C
profano ./tmp/cpu-profiles/CPU.*.cpuprofile
```

This also works for `vite`, `vite build`, `tsx script.ts`, `next dev`, `nest start`, etc. Every child `node` process inherits `NODE_OPTIONS`, so if the wrapper spawns multiple Node workers each one gets its own `CPU.<timestamp>.<pid>.*.cpuprofile`. Pass them all to profano at once — it renders a separate table per file with a header separator so you can tell which worker was hot.

### Vitest

Vitest's official CPU profiling pattern uses the top-level `test.execArgv` option together with `test.fileParallelism: false` so profiles are not interleaved across files. This is pool-agnostic (`forks` or `threads`) — `--cpu-prof` works in both. Wire it behind an env var so you can opt in per-run:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

const cpuProf = process.env.VITEST_CPU_PROF === '1'

export default defineConfig({
  test: {
    // Serialize test files so profiles are not interleaved.
    // This is the officially documented way to profile Vitest.
    fileParallelism: cpuProf ? false : undefined,
    execArgv: cpuProf
      ? ['--cpu-prof', '--cpu-prof-dir=tmp/cpu-profiles']
      : [],
  },
})
```

Then profile a single test file:

```bash
VITEST_CPU_PROF=1 pnpm test --run src/some-file.test.ts
profano tmp/cpu-profiles/CPU.*.cpuprofile
```

Profile one file at a time — running the whole suite with profiling enabled generates dozens of overlapping `.cpuprofile` files and can overload the machine.

> Note: the `--prof` flag does **not** work with `pool: 'threads'` due to `node:worker_threads` limitations. `--cpu-prof` is the right choice for profiling Vitest and works with both pools.

**Profiling the Vitest main thread.** The `execArgv` above profiles the test workers, not the Vitest main process itself (where Vite plugin transforms and `globalSetup` run). To profile the main thread, invoke Vitest's entry file under `node --cpu-prof` directly:

```bash
node --cpu-prof --cpu-prof-dir=./tmp/main-profile ./node_modules/vitest/vitest.mjs --run
profano ./tmp/main-profile/CPU.*.cpuprofile
```

Use this when transform/setup time is high and worker-level profiling shows the hot path is outside test execution.

### Bun

Bun has a built-in V8-compatible CPU profiler with the same `--cpu-prof` flag as Node:

```bash
bun --cpu-prof --cpu-prof-dir=./tmp/cpu-profiles ./script.ts
profano ./tmp/cpu-profiles/CPU.*.cpuprofile
```

For wrappers that spawn `bun` (scripts, watchers, bundlers), use the `BUN_OPTIONS` env var — same idea as `NODE_OPTIONS` for Node:

```bash
BUN_OPTIONS="--cpu-prof --cpu-prof-dir=./tmp/cpu-profiles" bun run dev
# reproduce the slow path...
# then Ctrl+C
profano ./tmp/cpu-profiles/CPU.*.cpuprofile
```

Same signal rules apply as with Node: the profile is written on clean exit, `Ctrl+C` and `kill <pid>` (`SIGTERM`) both work, `kill -9` does not.

Bun also supports `--cpu-prof-name <filename>` for a fixed output name and `--cpu-prof-interval <microseconds>` to change the sampling rate (default 1000μs).

### Chrome DevTools

You can also record CPU profiles from Chrome DevTools (Performance tab → Record → stop → "Save profile…") and feed the exported `.cpuprofile` file to profano.

### Programmatic inspector

For fine-grained control, use Node's built-in `node:inspector` module to start and stop the profiler around a specific code path and write the result to disk.

## License

MIT
