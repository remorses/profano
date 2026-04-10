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

## Generating .cpuprofile files

Node.js has a built-in CPU profiler. Enable it with `--cpu-prof`:

```bash
node --cpu-prof --cpu-prof-dir=./tmp/cpu-profiles ./script.js
```

You can also use the `inspector` module programmatically, or enable profiling in Vitest via env vars like `VITEST_CPU_PROF=1` depending on your test setup.

## License

MIT
