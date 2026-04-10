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

Node has a built-in CPU profiler. Pass `--cpu-prof` when running a script and it writes a `.cpuprofile` file on exit:

```bash
node --cpu-prof --cpu-prof-dir=./tmp/cpu-profiles ./script.js
```

### Vitest

Enable CPU profiling conditionally via an env var so you can opt in per-run. Wire Node's `--cpu-prof` flag into the pool worker's `execArgv` in `vitest.config.ts`:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

const cpuProf = process.env.VITEST_CPU_PROF === '1'

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        // Run one fork at a time when profiling so the output is
        // manageable and the machine does not hang under load.
        maxForks: cpuProf ? 1 : undefined,
        execArgv: cpuProf
          ? ['--cpu-prof', '--cpu-prof-dir=tmp/cpu-profiles']
          : [],
      },
    },
  },
})
```

Then profile a single test file:

```bash
VITEST_CPU_PROF=1 pnpm test --run src/some-file.test.ts
profano tmp/cpu-profiles/CPU.*.cpuprofile
```

Always profile one file at a time. Running the whole suite with profiling enabled generates dozens of overlapping `.cpuprofile` files and can overload the machine.

### Dev servers and long-running scripts

Node's `--cpu-prof` flag writes the `.cpuprofile` on **normal process exit**. You don't need a custom signal handler — Node flushes the profile automatically when the process exits on `SIGINT` (`Ctrl+C`) or `SIGTERM` (`kill <pid>`), as long as nothing upstream sends `SIGKILL` (`kill -9`).

This means you can profile a dev server exactly like a normal script: start it with `--cpu-prof`, reproduce the slow path, then stop it with `Ctrl+C` or `kill <pid>`. The profile lands in the `--cpu-prof-dir` directory.

**Plain Node dev server:**

```bash
node --cpu-prof --cpu-prof-dir=./tmp/cpu-profiles ./server.js
# reproduce the slow path...
# then Ctrl+C (or `kill <pid>` from another terminal)
profano ./tmp/cpu-profiles/CPU.*.cpuprofile
```

**`pnpm dev` (or any script that spawns Node):**

Use `NODE_OPTIONS` so every Node process spawned by the script inherits the flag:

```bash
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=./tmp/cpu-profiles" pnpm dev
# reproduce the slow path...
# then Ctrl+C
profano ./tmp/cpu-profiles/CPU.*.cpuprofile
```

If `pnpm dev` spawns multiple Node workers (Next.js, Vite, Nest, etc.), each one gets its own `CPU.<timestamp>.<pid>.*.cpuprofile`. Pass them all to profano at once — profano will render a separate table per file with a header separator so you can tell which worker was hot.

To stop the process cleanly from another terminal, send `SIGTERM` (not `SIGKILL`):

```bash
kill <pid>        # sends SIGTERM, profile gets written
kill -TERM <pid>  # same thing, explicit
# NEVER use:
kill -9 <pid>     # SIGKILL, kernel kills the process before Node can flush
```

### Chrome DevTools

You can also record CPU profiles from Chrome DevTools (Performance tab → Record → stop → "Save profile…") and feed the exported `.cpuprofile` file to profano.

### Programmatic inspector

For fine-grained control, use Node's built-in `node:inspector` module to start and stop the profiler around a specific code path and write the result to disk.

## License

MIT
