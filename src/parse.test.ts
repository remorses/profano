// Regression tests for analyze() in parse.ts.
//
// The main invariant being protected here is: for any function identity
// (functionName + url + lineNumber), its totalSamples must be <= nonIdleSamples.
// That means %Total can never exceed 100%.
//
// Previous bug: V8's cpuprofile tree has one node per distinct call site,
// so a recursive function like updateFiberRecursively appears as multiple
// nodes that share the same callFrame. The old code summed per-node totals
// when aggregating by identity, so the same function was counted once per
// node per sample stack, producing %Total values like 462.3% on real
// React profiles.

import { describe, it, expect } from 'vitest'
import { analyze, type CpuProfile } from './parse.ts'

/** Build a minimal profile with two nodes sharing the same callFrame. */
function makeRecursiveProfile(): CpuProfile {
  return {
    nodes: [
      {
        id: 1,
        callFrame: { functionName: '(root)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 },
        children: [2],
      },
      {
        // Outer foo
        id: 2,
        callFrame: { functionName: 'foo', url: 'x.js', scriptId: '1', lineNumber: 0, columnNumber: 0 },
        children: [3],
      },
      {
        // Inner foo — same callFrame as node 2, different node id.
        // This is how V8 represents a recursive call where the same
        // source function appears at a deeper call site.
        id: 3,
        callFrame: { functionName: 'foo', url: 'x.js', scriptId: '1', lineNumber: 0, columnNumber: 0 },
        children: [4],
      },
      {
        id: 4,
        callFrame: { functionName: 'leaf', url: 'x.js', scriptId: '1', lineNumber: 1, columnNumber: 0 },
      },
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
    // foo appears at TWO different nodes on every sample's stack. The bug
    // would count it 6 times (2 per sample * 3 samples). Correct: 3 (once
    // per sample, regardless of how many stack frames share its identity).
    expect(foo!.totalSamples).toBe(3)
    expect(foo!.totalActivePercent).toBe(100)
    // foo is never a leaf in these samples, so self should be 0.
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
        {
          id: 1,
          callFrame: { functionName: '(idle)', url: '', scriptId: '0', lineNumber: -1, columnNumber: -1 },
        },
        {
          id: 2,
          callFrame: { functionName: 'work', url: 'y.js', scriptId: '1', lineNumber: 0, columnNumber: 0 },
        },
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
    // %Self is computed against nonIdleSamples (3), so 3/3 = 100%.
    expect(work!.activePercent).toBe(100)
    expect(work!.totalSamples).toBe(3)
    expect(work!.totalActivePercent).toBe(100)
  })
})
