---
name: profano
description: CLI tool to analyze V8 .cpuprofile files and print top functions by self-time or total-time in the terminal. Use when debugging CPU performance issues, investigating slow tests, or reviewing cpu profiles without opening Chrome DevTools.
---

# profano

`profano` is a terminal CLI that reads V8 `.cpuprofile` files and prints the heaviest functions as a table sorted by self-time or total (inclusive) time. Use it to quickly identify CPU hotspots from the terminal without loading the profile into Chrome DevTools or cpupro.

## When to use

- You have a `.cpuprofile` file (from `node --cpu-prof`, Vitest with `VITEST_CPU_PROF=1`, Chrome DevTools export, etc.) and want a quick top-N readout of the biggest offenders.
- You are an agent debugging slow code and need a grep-able, text-only view of where CPU time is spent.
- You want to compare hotspots across many profile files in one shot.

## Install

```bash
npm install -g profano
# or run on demand
npx profano profile.cpuprofile
```

## Usage

```bash
# Top 30 functions sorted by self-time (default)
profano ./tmp/cpu-profiles/CPU.*.cpuprofile

# Sort by total/inclusive time
profano profile.cpuprofile --sort total

# Show more rows
profano profile.cpuprofile -n 50
```

Shell globs are expanded, so `profano ./tmp/*.cpuprofile` works even if your shell didn't expand the pattern.

## Reading the output

- **Self** — samples where the function was on top of the stack (exclusive).
- **Total** — samples where the function was anywhere on the stack (inclusive).
- **%Self / %Total** — percent of non-idle active samples. Idle, GC, and VM pseudo-frames are excluded so you see real hotspots even when the profile is mostly idle.

Start with `--sort self` to find CPU-bound leaves (hot inner functions). Switch to `--sort total` to find expensive callers that dominate wall time.

## Generating .cpuprofile files

```bash
# Node.js built-in profiler
node --cpu-prof --cpu-prof-dir=./tmp/cpu-profiles ./script.js

# Vitest (kimaki repo example)
VITEST_CPU_PROF=1 pnpm test --run src/some-file.test.ts
```

Then feed the resulting `.cpuprofile` files to `profano`.
