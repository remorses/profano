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
import { analyze, type CpuProfile } from './parse.ts'

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
