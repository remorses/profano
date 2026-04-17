// Regression tests for analyze() in parse.ts.
//
// The core invariant being protected here is: for any function identity
// ((functionName, scriptId, lineNumber, columnNumber)), its totalSamples must
// be <= nonIdleSamples, so %Total never exceeds 100%.
//
// History:
// - 0.0.3 fix: V8's cpuprofile tree creates one node per distinct call site,
//   so a recursive function like updateFiberRecursively appears as multiple
//   nodes with identical callFrames. The old code summed per-node totals
//   when aggregating, producing %Total values like 462.3%. Fix: dedupe by
//   function identity per sample while walking the ancestor chain.
// - 0.0.5 fix: identity was `functionName|url|lineNumber` which merged
//   distinct anonymous functions on the same minified line and was also
//   unsafe to split() because function names can legally contain `|`.
//   Fix: include scriptId and columnNumber in the identity, and use
//   JSON.stringify + a side metadata map instead of delimiter parsing.

import { describe, it, expect } from 'vitest'
import { analyze, buildTree, loadProfile, type CpuProfile } from './parse.ts'
import { formatTree } from './format.ts'
import { join } from 'node:path'

/** Strip ANSI escape sequences so snapshots are readable and stable
 *  regardless of color support in the test environment. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Helper: build a minimal CallFrame with sensible defaults. */
function frame(opts: {
  functionName: string
  url?: string
  scriptId?: string
  lineNumber?: number
  columnNumber?: number
}) {
  return {
    functionName: opts.functionName,
    url: opts.url ?? 'x.js',
    scriptId: opts.scriptId ?? '1',
    lineNumber: opts.lineNumber ?? 0,
    columnNumber: opts.columnNumber ?? 0,
  }
}

/** Build a minimal profile with two nodes sharing the same callFrame —
 * i.e. a recursive `foo` call appearing at two stack depths. */
function makeRecursiveProfile(): CpuProfile {
  return {
    nodes: [
      { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2] },
      { id: 2, callFrame: frame({ functionName: 'foo' }), children: [3] },
      // Same callFrame as node 2 — V8 would do this for a recursive call.
      { id: 3, callFrame: frame({ functionName: 'foo' }), children: [4] },
      { id: 4, callFrame: frame({ functionName: 'leaf', lineNumber: 1 }) },
    ],
    samples: [4, 4, 4],
    startTime: 0,
    endTime: 3000,
    timeDeltas: [1000, 1000, 1000],
  }
}

describe('analyze', () => {
  it('dedupes recursive function identities so %Total stays <= 100%', () => {
    const { functions, nonIdleSamples } = analyze(makeRecursiveProfile())
    expect(nonIdleSamples).toBe(3)

    const foo = functions.find((f) => f.functionName === 'foo')
    expect(foo).toBeDefined()
    // foo appears at TWO different nodes on every sample's stack. The old bug
    // counted it 6 times (2 per sample * 3 samples). Correct: 3.
    expect(foo!.totalSamples).toBe(3)
    expect(foo!.totalActivePercent).toBe(100)
    expect(foo!.selfSamples).toBe(0)

    const leaf = functions.find((f) => f.functionName === 'leaf')
    expect(leaf).toBeDefined()
    expect(leaf!.selfSamples).toBe(3)
    expect(leaf!.totalSamples).toBe(3)
    expect(leaf!.totalActivePercent).toBe(100)
  })

  it('keeps every function identity within [0, 100]% for both self and total', () => {
    const { functions } = analyze(makeRecursiveProfile())
    for (const fn of functions) {
      expect(fn.activePercent).toBeGreaterThanOrEqual(0)
      expect(fn.activePercent).toBeLessThanOrEqual(100)
      expect(fn.totalActivePercent).toBeGreaterThanOrEqual(0)
      expect(fn.totalActivePercent).toBeLessThanOrEqual(100)
    }
  })

  it('excludes idle/gc/program/root frames from the function list', () => {
    const { functions } = analyze(makeRecursiveProfile())
    const names = new Set(functions.map((f) => f.functionName))
    expect(names.has('(root)')).toBe(false)
    expect(names.has('(idle)')).toBe(false)
    expect(names.has('(garbage collector)')).toBe(false)
    expect(names.has('(program)')).toBe(false)
  })

  it('computes nonIdleSamples correctly when idle frames are present', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(idle)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }) },
        { id: 2, callFrame: frame({ functionName: 'work', url: 'y.js' }) },
      ],
      samples: [1, 1, 2, 2, 2],
      startTime: 0,
      endTime: 5000,
      timeDeltas: [1000, 1000, 1000, 1000, 1000],
    }
    const { totalSamples, nonIdleSamples, functions } = analyze(profile)
    expect(totalSamples).toBe(5)
    expect(nonIdleSamples).toBe(3)

    const work = functions.find((f) => f.functionName === 'work')
    expect(work).toBeDefined()
    expect(work!.selfSamples).toBe(3)
    expect(work!.activePercent).toBe(100)
    expect(work!.totalSamples).toBe(3)
    expect(work!.totalActivePercent).toBe(100)
  })

  // ─── oracle review edge cases ───────────────────────────────────────────

  it('treats same line but different column as DISTINCT identities', () => {
    // Common in minified code: many anonymous functions on `bundle.js:0`
    // with different column numbers. Before the fix they all merged.
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2, 3] },
        { id: 2, callFrame: frame({ functionName: '', url: 'bundle.js', lineNumber: 0, columnNumber: 100 }) },
        { id: 3, callFrame: frame({ functionName: '', url: 'bundle.js', lineNumber: 0, columnNumber: 200 }) },
      ],
      samples: [2, 3, 2, 3],
      startTime: 0,
      endTime: 4000,
      timeDeltas: [1000, 1000, 1000, 1000],
    }
    const { functions } = analyze(profile)
    // Two distinct anonymous rows — not merged into one row with self=4.
    const anonRows = functions.filter((f) => f.functionName === '(anonymous)')
    expect(anonRows.length).toBe(2)
    expect(anonRows.every((f) => f.selfSamples === 2)).toBe(true)
    const columns = anonRows.map((f) => f.columnNumber).sort((a, b) => a - b)
    expect(columns).toEqual([100, 200])
  })

  it('treats same line/column but different scriptId as DISTINCT identities', () => {
    // Two different loaded scripts can land at the same line:col (iframes,
    // sandboxes, VM scripts) but they are not the same function.
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2, 3] },
        { id: 2, callFrame: frame({ functionName: 'init', url: 'app.js', scriptId: 'script-1', lineNumber: 10, columnNumber: 5 }) },
        { id: 3, callFrame: frame({ functionName: 'init', url: 'app.js', scriptId: 'script-2', lineNumber: 10, columnNumber: 5 }) },
      ],
      samples: [2, 2, 3],
      startTime: 0,
      endTime: 3000,
      timeDeltas: [1000, 1000, 1000],
    }
    const { functions } = analyze(profile)
    const initRows = functions.filter((f) => f.functionName === 'init')
    expect(initRows.length).toBe(2)
    const scriptIds = initRows.map((f) => f.scriptId).sort()
    expect(scriptIds).toEqual(['script-1', 'script-2'])
  })

  it('round-trips function names containing "|" without losing data', () => {
    // The 0.0.3 implementation used key.split('|') which corrupted names
    // like "a|b" into { functionName: "a", url: "b", lineNumber: NaN }.
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2] },
        { id: 2, callFrame: frame({ functionName: 'a|b|c', url: 'weird.js', lineNumber: 42, columnNumber: 7 }) },
      ],
      samples: [2, 2, 2],
      startTime: 0,
      endTime: 3000,
      timeDeltas: [1000, 1000, 1000],
    }
    const { functions } = analyze(profile)
    const fn = functions.find((f) => f.functionName === 'a|b|c')
    expect(fn).toBeDefined()
    expect(fn!.url).toBe('weird.js')
    expect(fn!.lineNumber).toBe(42)
    expect(fn!.columnNumber).toBe(7)
    expect(fn!.selfSamples).toBe(3)
    expect(Number.isNaN(fn!.lineNumber)).toBe(false)
  })

  it('counts self + total correctly when the same function is both leaf and ancestor in one sample', () => {
    // Stack: root -> foo (node 2) -> bar -> foo (node 4, leaf)
    // foo appears twice on the stack. We expect:
    //   - foo.selfSamples === 3 (node 4 is the leaf for all 3 samples)
    //   - foo.totalSamples === 3 (deduped — not 6)
    //   - bar.selfSamples === 0
    //   - bar.totalSamples === 3
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2] },
        { id: 2, callFrame: frame({ functionName: 'foo', lineNumber: 5, columnNumber: 1 }), children: [3] },
        { id: 3, callFrame: frame({ functionName: 'bar', lineNumber: 10, columnNumber: 1 }), children: [4] },
        // Same identity as node 2 — same functionName, scriptId, line, column.
        { id: 4, callFrame: frame({ functionName: 'foo', lineNumber: 5, columnNumber: 1 }) },
      ],
      samples: [4, 4, 4],
      startTime: 0,
      endTime: 3000,
      timeDeltas: [1000, 1000, 1000],
    }
    const { functions, nonIdleSamples } = analyze(profile)
    expect(nonIdleSamples).toBe(3)

    const foo = functions.find((f) => f.functionName === 'foo')
    expect(foo).toBeDefined()
    expect(foo!.selfSamples).toBe(3)
    expect(foo!.totalSamples).toBe(3)
    expect(foo!.activePercent).toBe(100)
    expect(foo!.totalActivePercent).toBe(100)

    const bar = functions.find((f) => f.functionName === 'bar')
    expect(bar).toBeDefined()
    expect(bar!.selfSamples).toBe(0)
    expect(bar!.totalSamples).toBe(3)
    expect(bar!.totalActivePercent).toBe(100)
  })

  it('computes selfMs and totalMs from timeDeltas', () => {
    // Stack: root -> foo -> bar (leaf)
    // timeDeltas: [500, 1000, 2000] µs
    // bar is the leaf for all 3 samples → selfMs = (500+1000+2000)/1000 = 3.5ms
    // foo is on the stack for all 3 samples → totalMs = 3.5ms, selfMs = 0
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2] },
        { id: 2, callFrame: frame({ functionName: 'foo', lineNumber: 1 }), children: [3] },
        { id: 3, callFrame: frame({ functionName: 'bar', lineNumber: 2 }) },
      ],
      samples: [3, 3, 3],
      startTime: 0,
      endTime: 3500,
      timeDeltas: [500, 1000, 2000],
    }
    const { functions } = analyze(profile)

    const bar = functions.find(f => f.functionName === 'bar')
    expect(bar).toBeDefined()
    expect(bar!.selfMs).toBeCloseTo(3.5, 5)
    expect(bar!.totalMs).toBeCloseTo(3.5, 5)

    const foo = functions.find(f => f.functionName === 'foo')
    expect(foo).toBeDefined()
    expect(foo!.selfMs).toBe(0)
    expect(foo!.totalMs).toBeCloseTo(3.5, 5)
  })

  it('falls back to average delta when timeDeltas is missing', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2] },
        { id: 2, callFrame: frame({ functionName: 'work' }) },
      ],
      samples: [2, 2, 2, 2],
      startTime: 0,
      endTime: 4000, // 4000µs total, 4 samples → avg 1000µs each
    }
    const { functions } = analyze(profile)
    const work = functions.find(f => f.functionName === 'work')
    expect(work).toBeDefined()
    // 4 samples × 1000µs avg = 4000µs = 4ms
    expect(work!.selfMs).toBeCloseTo(4, 5)
    expect(work!.totalMs).toBeCloseTo(4, 5)
  })

  it('handles an empty samples array without crashing', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }) },
        { id: 2, callFrame: frame({ functionName: 'dead' }) },
      ],
      samples: [],
      startTime: 0,
      endTime: 0,
      timeDeltas: [],
    }
    const { totalSamples, nonIdleSamples, functions, durationSeconds } = analyze(profile)
    expect(totalSamples).toBe(0)
    expect(nonIdleSamples).toBe(0)
    expect(functions).toEqual([])
    expect(durationSeconds).toBe(0)
  })
})

// ─── buildTree + formatTree tests ─────────────────────────────────────────

/** A realistic-ish profile with branching call tree:
 *
 *  (root)
 *  └── main
 *      ├── handleRequest
 *      │   ├── dbQuery
 *      │   │   └── pgExecute  (leaf, sampled)
 *      │   └── serialize      (leaf, sampled)
 *      └── authCheck
 *          └── cryptoVerify    (leaf, sampled)
 *
 * Samples hit the three leaves with different frequencies to create
 * a realistic distribution for testing tree rendering.
 */
function makeBranchingProfile(): CpuProfile {
  return {
    nodes: [
      { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2] },
      { id: 2, callFrame: frame({ functionName: 'main', url: 'src/index.ts', lineNumber: 1 }), children: [3, 6] },
      { id: 3, callFrame: frame({ functionName: 'handleRequest', url: 'src/server.ts', lineNumber: 10 }), children: [4, 5] },
      { id: 4, callFrame: frame({ functionName: 'dbQuery', url: 'src/db.ts', lineNumber: 20 }), children: [8] },
      { id: 5, callFrame: frame({ functionName: 'serialize', url: 'src/format.ts', lineNumber: 30 }) },
      { id: 6, callFrame: frame({ functionName: 'authCheck', url: 'src/auth.ts', lineNumber: 40 }), children: [7] },
      { id: 7, callFrame: frame({ functionName: 'cryptoVerify', url: '', lineNumber: -1 }) },
      { id: 8, callFrame: frame({ functionName: 'pgExecute', url: 'node_modules/pg/client.ts', lineNumber: 89 }) },
    ],
    // 10 samples: 5 pgExecute, 2 serialize, 3 cryptoVerify
    samples: [8, 8, 8, 8, 8, 5, 5, 7, 7, 7],
    startTime: 0,
    endTime: 10_000_000, // 10s in µs
    timeDeltas: [
      1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000,
      1_000_000, 1_000_000,
      1_000_000, 1_000_000, 1_000_000,
    ],
  }
}

describe('buildTree', () => {
  it('builds correct hierarchy with self/total times', () => {
    const { root, nonIdleSamples } = buildTree(makeBranchingProfile())
    expect(nonIdleSamples).toBe(10)
    expect(root.functionName).toBe('(all)')
    expect(root.children.length).toBe(1) // main

    const main = root.children[0]!
    expect(main.functionName).toBe('main')
    expect(main.totalMs).toBe(10_000) // all 10s flow through main
    expect(main.selfMs).toBe(0) // main is never the leaf

    const handleReq = main.children.find((c) => c.functionName === 'handleRequest')!
    expect(handleReq.totalMs).toBe(7000) // 5 pgExecute + 2 serialize
    expect(handleReq.selfMs).toBe(0)

    const authCheck = main.children.find((c) => c.functionName === 'authCheck')!
    expect(authCheck.totalMs).toBe(3000) // 3 cryptoVerify
  })

  it('excludes idle nodes from the tree', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2, 3] },
        { id: 2, callFrame: frame({ functionName: '(idle)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }) },
        { id: 3, callFrame: frame({ functionName: 'work', url: 'w.js' }) },
      ],
      samples: [2, 2, 3, 3, 3],
      startTime: 0,
      endTime: 5_000_000,
      timeDeltas: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
    }
    const { root, nonIdleSamples } = buildTree(profile)
    expect(nonIdleSamples).toBe(3)
    // Only 'work' should appear, no idle
    expect(root.children.length).toBe(1)
    expect(root.children[0]!.functionName).toBe('work')
  })

  it('prunes nodes with zero samples', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame({ functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 }), children: [2, 3] },
        { id: 2, callFrame: frame({ functionName: 'hot' }), children: [4] },
        { id: 3, callFrame: frame({ functionName: 'cold', lineNumber: 99 }) }, // never sampled
        { id: 4, callFrame: frame({ functionName: 'leaf', lineNumber: 1 }) },
      ],
      samples: [4, 4],
      startTime: 0,
      endTime: 2_000_000,
      timeDeltas: [1_000_000, 1_000_000],
    }
    const { root } = buildTree(profile)
    // 'cold' should be pruned — it has 0 totalMs
    expect(root.children.length).toBe(1)
    expect(root.children[0]!.functionName).toBe('hot')
  })
})

describe('formatTree', () => {
  it('renders the full tree with inline snapshot', () => {
    const result = buildTree(makeBranchingProfile())
    const output = stripAnsi(formatTree(result))
    expect(output).toMatchInlineSnapshot(`
      "Duration: 10.00s
      Samples:  10 active / 10 total (0.0% idle)

      [100.0% 10.00s] (all)
      └── [100.0% 10.00s] main  src/index.ts:1
          ├── [ 70.0% 7.00s] handleRequest  src/server.ts:10
          │   ├── [ 50.0% 5.00s] dbQuery  src/db.ts:20
          │   │   └── [ 50.0% 5.00s] pgExecute  node_modules/pg/client.ts:89
          │   └── [ 20.0% 2.00s] serialize  src/format.ts:30
          └── [ 30.0% 3.00s] authCheck  src/auth.ts:40
              └── [ 30.0% 3.00s] cryptoVerify"
    `)
  })

  it('renders with minPercent filtering and collapsed chains', () => {
    const result = buildTree(makeBranchingProfile())
    const output = stripAnsi(formatTree({ ...result, minPercent: 25 }))
    expect(output).toMatchInlineSnapshot(`
      "Duration: 10.00s
      Samples:  10 active / 10 total (0.0% idle)

      [100.0% 10.00s] (all)
      └── [100.0% 10.00s] main  src/index.ts:1
          ├── [ 70.0% 7.00s] handleRequest  src/server.ts:10
          │   └── [ 50.0% 5.00s] dbQuery  src/db.ts:20
          │       └── [ 50.0% 5.00s] pgExecute  node_modules/pg/client.ts:89
          └── [ 30.0% 3.00s] authCheck  src/auth.ts:40
              └── [ 30.0% 3.00s] cryptoVerify"
    `)
  })

  it('renders with maxDepth limit', () => {
    const result = buildTree(makeBranchingProfile())
    const output = stripAnsi(formatTree({ ...result, maxDepth: 2 }))
    expect(output).toMatchInlineSnapshot(`
      "Duration: 10.00s
      Samples:  10 active / 10 total (0.0% idle)

      [100.0% 10.00s] (all)
      └── [100.0% 10.00s] main  src/index.ts:1
          ├── [ 70.0% 7.00s] handleRequest  src/server.ts:10
          └── [ 30.0% 3.00s] authCheck  src/auth.ts:40"
    `)
  })

  it('renders with focus on a subtree', () => {
    const result = buildTree(makeBranchingProfile())
    const output = stripAnsi(formatTree({ ...result, focus: 'handleRequest' }))
    expect(output).toMatchInlineSnapshot(`
      "Duration: 10.00s
      Samples:  10 active / 10 total (0.0% idle)

      [ 70.0% 7.00s] handleRequest  src/server.ts:10
      ├── [ 50.0% 5.00s] dbQuery  src/db.ts:20
      │   └── [ 50.0% 5.00s] pgExecute  node_modules/pg/client.ts:89
      └── [ 20.0% 2.00s] serialize  src/format.ts:30"
    `)
  })

  it('shows error message when focus target not found', () => {
    const result = buildTree(makeBranchingProfile())
    const output = formatTree({ ...result, focus: 'nonexistent' })
    expect(output).toBe('No function matching "nonexistent" found in the call tree.')
  })

  it('renders with both minPercent and maxDepth combined', () => {
    const result = buildTree(makeBranchingProfile())
    const output = stripAnsi(formatTree({ ...result, minPercent: 10, maxDepth: 3 }))
    expect(output).toMatchInlineSnapshot(`
      "Duration: 10.00s
      Samples:  10 active / 10 total (0.0% idle)

      [100.0% 10.00s] (all)
      └── [100.0% 10.00s] main  src/index.ts:1
          ├── [ 70.0% 7.00s] handleRequest  src/server.ts:10
          │   ├── [ 50.0% 5.00s] dbQuery  src/db.ts:20
          │   └── [ 20.0% 2.00s] serialize  src/format.ts:30
          └── [ 30.0% 3.00s] authCheck  src/auth.ts:40
              └── [ 30.0% 3.00s] cryptoVerify"
    `)
  })
})

// ─── Real-world .cpuprofile snapshot ──────────────────────────────────────

describe('real-world cpuprofile tree', () => {
  const profilePath = join(import.meta.dirname!, '..', 'realworld-polar-dev.cpuprofile')

  it('renders tree with --min-percent 5 --max-depth 4', () => {
    const profile = loadProfile(profilePath)
    const result = buildTree(profile)
    const output = stripAnsi(formatTree({ ...result, minPercent: 5, maxDepth: 4 }))
    expect(output).toMatchInlineSnapshot(`
      "Duration: 2.54s
      Samples:  2150 active / 2316 total (7.2% idle)

      [100.0% 2.33s] (all)
      ├── [ 49.3% 1.15s] resolveConfig  nm/vite/dist/node/chunks/node.js:34002
      │   └── [ 49.0% 1.14s] (anonymous)  nm/vite/dist/node/chunks/node.js:34311
      │       └── [ 49.0% 1.14s] configResolved  dist/vite-plugin.js:134
      │           └── [ 48.9% 1.14s] syncNavigation  lib/sync.js:74
      ├── [ 18.0% 419.3ms] enrichPage  lib/sync.js:93
      │   └── [ 11.3% 263.3ms] collectMdxIconRefs  lib/mdx-processor.js:43
      │       ├── [  5.9% 137.2ms] normalizeMdx → parse [3.1%] → parser [3.1%] → write [1.3%] → main [1.2%] → go [1.2%] → flowContinue [0.8%] → writeToChild [0.7%] → write [0.7%] → main [0.7%] → go [0.7%] → inside [0.1%] → before [0.1%] → mdxExpressionParse [0.1%] → eventsToAcorn [0.1%] → parseExpressionAt [0.1%] → pp.nextToken [0.1%] → readToken [0.1%] → pp.getTokenFromCode [0.1%] → pp.readNumber [0.1%] → pp.fullCharCodeAtPos [0.1%]  mintlify/normalize-mdx.js:12
      │       └── [  5.1% 118.9ms] mdxParse  nm/safe-mdx/dist/parse.js:8
      │           └── [  5.1% 118.9ms] processSync  nm/unified/lib/index.js:808
      ├── [ 16.3% 379.6ms] run  esm/module_job:418
      │   └── [ 16.2% 377.0ms] evaluate
      │       └── [  8.6% 199.6ms] (anonymous)  esm/translators:228
      │           └── [  8.6% 199.6ms] loadCJSModuleWithModuleLoad  esm/translators:323
      └── [ 13.9% 323.5ms] loadConfigFromBundledFile  nm/vite/dist/node/chunks/node.js:34562
          └── [ 13.9% 323.5ms] importModuleDynamicallyCallback  esm/utils:251
              └── [ 13.9% 323.5ms] defaultImportModuleDynamicallyForModule  esm/utils:222
                  └── [ 13.9% 323.5ms] import  esm/loader:644"
    `)
  })

  it('renders tree focused on enrichPage', () => {
    const profile = loadProfile(profilePath)
    const result = buildTree(profile)
    const output = stripAnsi(formatTree({ ...result, focus: 'enrichPage', maxDepth: 3 }))
    expect(output).toMatchInlineSnapshot(`
      "Duration: 2.54s
      Samples:  2150 active / 2316 total (7.2% idle)

      [ 25.8% 602.5ms] enrichPage  lib/sync.js:93
      ├── [ 14.5% 338.4ms] processMdx  lib/mdx-processor.js:19
      │   ├── [  7.1% 165.7ms] normalizeMdx  mintlify/normalize-mdx.js:12
      │   │   ├── [  5.0% 117.0ms] parse  nm/unified/lib/index.js:662
      │   │   ├── [  1.2% 27.9ms] toMarkdown  nm/mdast-util-to-markdown/lib/index.js:29
      │   │   ├── [  0.7% 15.8ms] runSync  nm/unified/lib/index.js:943
      │   │   ├── [  0.2% 3.7ms] apply  nm/unified/lib/callable-instance.js:22
      │   │   └── [  0.1% 1.3ms] frontmatterToMarkdown  nm/mdast-util-frontmatter/lib/index.js:91
      │   ├── [  6.8% 158.6ms] mdxParse  nm/safe-mdx/dist/parse.js:8
      │   │   └── [  6.8% 158.6ms] processSync  nm/unified/lib/index.js:808
      │   ├── [  0.5% 11.2ms] parsePageFrontmatter  lib/page-frontmatter.js:46
      │   │   ├── [  0.4% 8.8ms] parseFrontmatterObject  lib/frontmatter.js:73
      │   │   └── [  0.1% 1.2ms] (anonymous)  nm/zod/v4/core/parse.js:30
      │   └── [  0.1% 2.9ms] collectImageSrcs  lib/mdx-processor.js:102
      │       └── [  0.1% 2.9ms] walk  lib/mdx-processor.js:104
      ├── [  8.5% 197.8ms] collectMdxIconRefs  lib/mdx-processor.js:43
      │   ├── [  4.3% 99.2ms] normalizeMdx  mintlify/normalize-mdx.js:12
      │   │   ├── [  3.1% 73.2ms] parse  nm/unified/lib/index.js:662
      │   │   ├── [  0.8% 18.4ms] toMarkdown  nm/mdast-util-to-markdown/lib/index.js:29
      │   │   └── [  0.3% 7.5ms] runSync  nm/unified/lib/index.js:943
      │   ├── [  3.8% 87.5ms] mdxParse  nm/safe-mdx/dist/parse.js:8
      │   │   └── [  3.8% 87.5ms] processSync  nm/unified/lib/index.js:808
      │   ├── [  0.4% 10.0ms] parsePageFrontmatter  lib/page-frontmatter.js:46
      │   │   ├── [  0.4% 8.7ms] parseFrontmatterObject  lib/frontmatter.js:73
      │   │   └── [  0.1% 1.3ms] inst.safeParse  nm/zod/v4/classic/schemas.js:39
      │   └── [  0.1% 1.2ms] collectIconRefsFromMdast  lib/mdx-processor.js:49
      │       └── [  0.1% 1.2ms] walk  lib/mdx-processor.js:54
      ├── [  1.1% 26.1ms] processImage  lib/image-processor.js:47
      │   ├── [  0.8% 19.1ms] processImageBuffer  lib/image-processor.js:53
      │   │   ├── [  0.6% 13.9ms] importModuleDynamicallyCallback  esm/utils:251
      │   │   └── [  0.2% 5.0ms] gitBlobSha  lib/image-processor.js:85
      │   └── [  0.3% 7.0ms] readFileSync  node:fs:432
      │       └── [  0.3% 7.0ms] tryReadSync  node:fs:411
      ├── [  1.0% 24.1ms] readFileSync  node:fs:432
      │   └── [  1.0% 24.1ms] readFileUtf8
      ├── [  0.3% 6.2ms] fetchRemoteImageBuffer  lib/sync.js:237
      │   └── [  0.3% 6.2ms] fetch  web/exposed-window-or-worker:77
      │       └── [  0.3% 6.2ms] fetch  undici/undici:16553
      ├── [  0.2% 3.8ms] gitBlobSha  lib/git-sha.js:11
      │   ├── [  0.1% 2.5ms] from  node:buffer:320
      │   │   └── [  0.1% 1.2ms] fromString  node:buffer:507
      │   └── [  0.1% 1.3ms] createHash  node:crypto:143
      │       └── [  0.1% 1.3ms] Hash  node:internal/crypto/hash:89
      ├── [  0.1% 2.5ms] resolveMdxPath  lib/sync.js:315
      │   └── [  0.1% 1.3ms] existsSync  node:fs:276
      │       └── [  0.1% 1.3ms] existsSync
      ├── [  0.1% 1.3ms] mdxParse  nm/safe-mdx/dist/parse.js:8
      ├── [  0.1% 1.3ms] slugToHref  lib/sync.js:324
      └── [  0.0% 1.1ms] dirname  node:path:1440"
    `)
  })
})
