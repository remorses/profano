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

### Browser pages via playwriter

You can drive Chrome's V8 CPU profiler over CDP from the shell using [playwriter](https://playwriter.dev), which makes it scriptable and agent-friendly. playwriter has no dedicated profiling docs or helpers — it simply forwards raw CDP `Profiler.*` commands — so the steps below are the canonical workflow.

#### 1. Install the playwriter Chrome extension

playwriter talks to Chrome through a browser extension that you need to install from the Chrome Web Store. Without it, the CLI cannot connect to any tab.

[**Install Playwriter MCP from the Chrome Web Store**](https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe)

After installing, pin the extension and click its icon on the tab you want playwriter to control — or launch Chrome with `--allowlisted-extension-id=jfeammnjpkecdekppnclgkkffahnhfhe --auto-accept-this-tab-capture` to skip the per-tab approval. See the playwriter skill for the full Chrome flags per OS.

#### 2. Install the playwriter CLI and read the skill

```bash
npm install -g playwriter@latest
playwriter skill
```

Read the full skill output before continuing — it covers session isolation, the sandboxed filesystem, and the `getCDPSession` helper.

#### 3. Start a playwriter session from your project root

Run `playwriter session new` from the directory you want your profiles written to. The session sandbox captures that directory at creation time and only allows writes inside it (plus `/tmp` and `os.tmpdir()`).

```bash
playwriter session new
# Session 1 created. Use with: playwriter -s 1 -e "..."
```

#### 4. Open a new page

```bash
playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" })'
```

Replace the URL with your dev server or any page you want to profile.

#### 5. Start the V8 profiler

Attach a CDP session via playwriter's `getCDPSession` helper (do **not** use `page.context().newCDPSession()` — it does not work through the playwriter relay), then enable and start the profiler.

```bash
playwriter -s 1 -e "$(cat <<'EOF'
const cdp = await getCDPSession({ page: state.page })
state.cdp = cdp
await cdp.send('Profiler.enable')
// microseconds — 1000 = 1ms sample interval (default). Lower = finer detail, bigger file.
await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
await cdp.send('Profiler.start')
console.log('profiling started')
EOF
)"
```

#### 6. Interact with the page

Do whatever triggers the code path you want to profile — click a button, scroll, navigate, type into a form. Only the work that happens between `Profiler.start` and `Profiler.stop` ends up in the profile.

```bash
playwriter -s 1 -e 'await state.page.locator("button").first().click(); await state.page.waitForTimeout(2000)'
```

#### 7. Stop the profiler and save the .cpuprofile

```bash
playwriter -s 1 -e "$(cat <<'EOF'
const { profile } = await state.cdp.send('Profiler.stop')
await state.cdp.send('Profiler.disable')
const fs = require('node:fs')
fs.mkdirSync('./tmp/cpu-profiles', { recursive: true })
const path = `./tmp/cpu-profiles/browser-${Date.now()}.cpuprofile`
fs.writeFileSync(path, JSON.stringify(profile))
console.log('wrote', path, '-', profile.samples.length, 'samples')
EOF
)"
```

The relative `./tmp/cpu-profiles/` path works because the session was created from your project root in step 3.

#### 8. Analyze with profano

```bash
# hot leaves (default)
profano ./tmp/cpu-profiles/browser-*.cpuprofile

# expensive callers
profano ./tmp/cpu-profiles/browser-*.cpuprofile --sort total -n 20
```

#### Gotchas

- **Session cwd is locked** — the playwriter sandbox captures the shell's cwd at session creation and reuses it for all later `-e` calls in that session. If writes to your project fail with `EPERM: access outside allowed directories`, create a fresh session from your project root.
- **Use `getCDPSession({ page })`** — not `page.context().newCDPSession()`. Only the playwriter helper is routed through the relay.
- **Sampling interval is in microseconds** — `Profiler.setSamplingInterval({ interval })` takes microseconds, not milliseconds. 1000 = 1ms (the default). Drop to 100 for high-resolution micro-profiling, raise to 10000 for long runs where you want a smaller file.
- **Extension overhead shows up in the profile** — CDP's V8 profiler sees every script running in the page's main world, including scripts injected by browser extensions like React DevTools. Profile in an incognito window with extensions disabled to see only your own code.

### Programmatic inspector

For fine-grained control, use Node's built-in `node:inspector` module to start and stop the profiler around a specific code path and write the result to disk.

## License

MIT
