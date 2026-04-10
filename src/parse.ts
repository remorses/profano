// Parse V8 .cpuprofile files and compute self-time / total-time per node.
// The .cpuprofile format is a JSON object with:
//   nodes: array of { id, callFrame: { functionName, url, lineNumber, ... }, children?: number[] }
//   samples: array of node IDs (one per sampling tick)
//   startTime / endTime: microseconds
//   timeDeltas: array of microsecond deltas between samples

import fs from 'node:fs'

export interface CallFrame {
  functionName: string
  url: string
  scriptId: string
  lineNumber: number
  columnNumber: number
}

export interface ProfileNode {
  id: number
  callFrame: CallFrame
  children?: number[]
}

export interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  startTime: number
  endTime: number
  timeDeltas?: number[]
}

export interface FunctionStat {
  functionName: string
  url: string
  lineNumber: number
  selfSamples: number
  selfPercent: number
  /** Percent of non-idle active samples (self) */
  activePercent: number
  totalSamples: number
  totalPercent: number
  /** Percent of non-idle active samples (total/inclusive) */
  totalActivePercent: number
}

const IDLE_NAMES = new Set(['(idle)', '(garbage collector)', '(program)', '(root)'])

export function loadProfile(filePath: string): CpuProfile {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw) as CpuProfile
}

export function analyze(profile: CpuProfile): {
  durationSeconds: number
  totalSamples: number
  nonIdleSamples: number
  functions: FunctionStat[]
} {
  const nodes = new Map<number, ProfileNode>()
  for (const node of profile.nodes) {
    nodes.set(node.id, node)
  }

  // Build parent map for walking up the call stack
  const parentMap = new Map<number, number>()
  for (const node of profile.nodes) {
    if (node.children) {
      for (const childId of node.children) {
        parentMap.set(childId, node.id)
      }
    }
  }

  // Identity key used everywhere below so a function identity (name+url+line)
  // never gets double-counted across multiple profiler nodes that happen to
  // share the same callFrame. V8 creates a separate tree node per distinct
  // call site, so a recursive function like updateFiberRecursively can appear
  // as many nodes with identical callFrames. Without identity-based dedup the
  // same function is counted once per node per sample stack, which inflates
  // %Total far above 100%.
  const identityOf = (node: ProfileNode): string => {
    const { functionName, url, lineNumber } = node.callFrame
    return `${functionName}|${url}|${lineNumber}`
  }

  // Self-time per identity. Each sample contributes to exactly one leaf node,
  // so summing by identity can never exceed sampleCount.
  const selfByIdentity = new Map<string, number>()
  for (const id of profile.samples) {
    const node = nodes.get(id)
    if (!node) continue
    const key = identityOf(node)
    selfByIdentity.set(key, (selfByIdentity.get(key) || 0) + 1)
  }

  // Total-time (inclusive) per identity. For each sample, walk from the
  // sampled leaf up to root and increment an identity at most ONCE per
  // sample — so a function that appears on every active sample's stack tops
  // out at exactly nonIdleSamples, giving %Total <= 100%.
  const totalByIdentity = new Map<string, number>()
  for (const id of profile.samples) {
    const visitedNodes = new Set<number>()          // break node-level cycles
    const visitedIdentities = new Set<string>()     // per-sample identity dedup
    let current: number | undefined = id
    while (current !== undefined) {
      if (visitedNodes.has(current)) break
      visitedNodes.add(current)
      const node = nodes.get(current)
      if (node) {
        const key = identityOf(node)
        if (!visitedIdentities.has(key)) {
          visitedIdentities.add(key)
          totalByIdentity.set(key, (totalByIdentity.get(key) || 0) + 1)
        }
      }
      current = parentMap.get(current)
    }
  }

  const sampleCount = profile.samples.length
  let nonIdleSamples = 0
  for (const id of profile.samples) {
    const node = nodes.get(id)
    if (node && !IDLE_NAMES.has(node.callFrame.functionName)) {
      nonIdleSamples++
    }
  }

  // Aggregate FunctionStat entries directly from the per-identity maps.
  const fnMap = new Map<string, FunctionStat>()
  const allKeys = new Set<string>([...selfByIdentity.keys(), ...totalByIdentity.keys()])
  for (const key of allKeys) {
    const [functionName, url, lineStr] = key.split('|')
    if (IDLE_NAMES.has(functionName ?? '')) continue
    const self = selfByIdentity.get(key) || 0
    const total = totalByIdentity.get(key) || 0
    if (self === 0 && total === 0) continue
    fnMap.set(key, {
      functionName: functionName || '(anonymous)',
      url: url ?? '',
      lineNumber: Number(lineStr ?? -1),
      selfSamples: self,
      selfPercent: 0,
      activePercent: 0,
      totalSamples: total,
      totalPercent: 0,
      totalActivePercent: 0,
    })
  }

  // Compute percentages, sort by self-time by default
  const functions: FunctionStat[] = [...fnMap.values()]
    .map((fn) => ({
      ...fn,
      selfPercent: sampleCount > 0 ? (fn.selfSamples / sampleCount) * 100 : 0,
      activePercent: nonIdleSamples > 0 ? (fn.selfSamples / nonIdleSamples) * 100 : 0,
      totalPercent: sampleCount > 0 ? (fn.totalSamples / sampleCount) * 100 : 0,
      totalActivePercent: nonIdleSamples > 0 ? (fn.totalSamples / nonIdleSamples) * 100 : 0,
    }))
    .sort((a, b) => b.selfSamples - a.selfSamples)

  const durationSeconds = (profile.endTime - profile.startTime) / 1e6

  return { durationSeconds, totalSamples: sampleCount, nonIdleSamples, functions }
}
