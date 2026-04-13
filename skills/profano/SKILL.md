---
name: profano
description: CLI tool to analyze V8 .cpuprofile files and print top functions by self-time or total-time in the terminal. ALWAYS load this skill when CPU profiling JavaScript or TypeScript programs (Node, Vitest, Bun, Chrome DevTools exports) — it shows how to generate .cpuprofile files and how to inspect them from the terminal without opening Chrome DevTools.
---

# profano

`profano` is a terminal CLI that reads V8 `.cpuprofile` files and prints the heaviest functions as a table sorted by self-time or total (inclusive) time. Use it to quickly identify CPU hotspots from the terminal without loading the profile into Chrome DevTools or cpupro.

## When to use

- You have a `.cpuprofile` file (from `node --cpu-prof`, Vitest, Chrome DevTools export, etc.) and want a quick top-N readout of the biggest offenders.
- You are an agent debugging slow code and need a grep-able, text-only view of where CPU time is spent.
- You want to compare hotspots across many profile files in one shot.

## How to use

**Always run `profano --help` first.** The help output is the source of truth for all commands, options, and examples. Read the full untruncated output — do not pipe it through `head`, `tail`, or `sed`.

For full setup, usage examples, how to generate `.cpuprofile` files (Node, Vitest with a ready-to-copy `vitest.config.ts`, Chrome DevTools), and how to read the output columns, fetch the README:

```bash
curl -s https://raw.githubusercontent.com/remorses/profano/main/README.md
```

## Profiling React component renders in the browser

React 19.2+ exposes React Performance Track entries in development and profiling builds. In development builds, many component render entries are observable as `PerformanceMeasure` objects with React-specific `detail` metadata. The observer below captures that measure-based subset — it does not reproduce every entry React shows in DevTools (some use `console.timeStamp` instead).

**Requirements:** React 19.2+ in development or profiling build. Production builds don't emit measures. Requires playwriter to control the browser. In profiling builds, components must be wrapped in `<Profiler>` or React DevTools extension must be installed for full coverage.

### Step 1: Install the observer on the page

First, create a playwriter session and navigate to your React app:

```bash
playwriter session new  # note the session ID
```

Then install the observer (replace `-s 1` with your session ID):

```bash
playwriter -s 1 -e "$(cat <<'EOF'
await state.page.evaluate(() => {
  window.__reactMeasures = []
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.detail?.devtools?.track) continue
      window.__reactMeasures.push({
        name: entry.name,
        duration: entry.duration,
        startTime: entry.startTime,
        track: entry.detail.devtools.track,
      })
    }
  })
  observer.observe({ type: 'measure', buffered: true })
})
console.log('Observer installed')
EOF
)"
```

React sets `detail.devtools.track` on every measure it emits. The filter `entry.detail?.devtools?.track` keeps only React data and excludes unrelated measures from other libraries. A `PerformanceObserver` is required because `performance.getEntriesByType('measure')` may miss entries that React clears.

### Step 2: Interact with the app

Click around, navigate, toggle themes, type — any React state change triggers component renders that get captured by the observer.

### Step 3: Collect and save as `.cpuprofile`

```bash
playwriter -s 1 -e "$(cat <<'EOF'
const measures = await state.page.evaluate(() => window.__reactMeasures)
if (!measures.length) { console.log('No React measures captured'); return }

const TICK = 100
const nodes = [
  { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
  { id: 2, callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [] },
]

const nameToId = new Map()
let nextId = 3
for (const m of measures) {
  const name = m.name.replace('\u200b', '')
  const key = m.track + '::' + name
  if (!nameToId.has(key)) {
    const id = nextId++
    nameToId.set(key, id)
    nodes.push({ id, callFrame: { functionName: name, scriptId: String(id), url: m.track, lineNumber: -1, columnNumber: -1 }, children: [] })
    nodes[0].children.push(id)
  }
}

const sorted = [...measures].sort((a, b) => a.startTime - b.startTime)
const t0 = sorted[0].startTime
const endUs = Math.round((Math.max(...sorted.map(m => m.startTime + m.duration)) - t0) * 1000)

const events = sorted.map(m => ({
  startUs: Math.round((m.startTime - t0) * 1000),
  endUs: Math.round((m.startTime + m.duration - t0) * 1000),
  nodeId: nameToId.get(m.track + '::' + m.name.replace('\u200b', '')),
}))

const samples = []
const timeDeltas = []
for (let t = 0; t < endUs; t += TICK) {
  let node = 2
  for (const ev of events) {
    if (t >= ev.startUs && t < ev.endUs) node = ev.nodeId
  }
  samples.push(node)
  timeDeltas.push(TICK)
}

const fs = require('node:fs')
const path = './react-profile.cpuprofile'
fs.writeFileSync(path, JSON.stringify({ nodes, samples, startTime: 0, endTime: endUs, timeDeltas }))
console.log('Saved', path, '— Nodes:', nodes.length, 'Samples:', samples.length)
EOF
)"
```

### Step 4: Analyze with profano

```bash
npx profano react-profile.cpuprofile --sort self
```

Always use `--sort self` — the flat export makes self-time the meaningful metric.

Example output:

```
Duration: 47.23s
Samples:  786 active / 472317 total (99.8% idle)
Sort:     self

   Self  %Self    Total  %Total  Function                Location
───────  ──────  ───────  ──────  ──────────────────────  ──────────────
    258   32.8%      258   32.8%  Mount                   Components ⚛
     87   11.1%       87   11.1%  EditorialPage           Components ⚛
     73    9.3%       73    9.3%  Update Blocked          Transition
     62    7.9%       62    7.9%  Cascading Update        Blocking
     41    5.2%       41    5.2%  SidebarTreeProvider     Components ⚛
     41    5.2%       41    5.2%  ExpandableContainer     Components ⚛
```

The Location column shows the React track: `Components ⚛` for component renders, `Transition`/`Blocking`/`Idle` for scheduler events. Scheduler events like `Mount`, `Cascading Update`, and `Update Blocked` tell you why renders happened — cascading updates are a common perf smell.

### How it works

React 19.2 calls `performance.measure(componentName, { detail: { devtools: { track: 'Components ⚛', ... } } })` for component renders in development builds. It prefixes component names with a zero-width space (`\u200b`). The conversion creates a flat `.cpuprofile` where each unique component/event becomes a node under root, and samples are filled proportionally to each measure's duration. This is an approximate exclusive-time view — overlapping parent/child spans are collapsed, so `--sort self` is the useful view. It does not preserve the nested flamegraph structure that React DevTools shows.
