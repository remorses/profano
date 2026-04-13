// Parse V8 .cpuprofile files and compute self-time / total-time per function.
// The .cpuprofile format is a JSON object with:
//   nodes: array of { id, callFrame: { functionName, url, scriptId, lineNumber, columnNumber }, children?: number[] }
//   samples: array of node IDs (one per sampling tick)
//   startTime / endTime: microseconds
//   timeDeltas: array of microsecond deltas between samples
//
// Why function identity matters: V8 creates a SEPARATE tree node per distinct
// call site, so a recursive or hot function appears as many profiler nodes
// with identical callFrames. Without identity-based dedup the same function
// gets counted once per node per sample stack — which inflates %Total above
// 100% on any profile with recursion or deep framework call chains.
//
// Identity key: we match Chrome DevTools (ProfileTreeModel.ts:21) and
// speedscope (src/import/chrome.ts:206-212) and identify a function by
// (functionName, scriptId, lineNumber, columnNumber). Dropping columnNumber
// merges distinct anonymous functions on a minified single line; dropping
// scriptId merges functions from two different loaded copies of the same
// script (iframes, sandboxes, etc).
//
// Key format: JSON.stringify([name, scriptId, line, column]). Using JSON
// instead of a delimiter string avoids collisions when functionName contains
// any separator character (| : @ etc).

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
  scriptId: string
  lineNumber: number
  columnNumber: number
  selfSamples: number
  selfPercent: number
  /** Percent of non-idle active samples (self) */
  activePercent: number
  /** Self-time in milliseconds, computed from timeDeltas */
  selfMs: number
  totalSamples: number
  totalPercent: number
  /** Percent of non-idle active samples (total/inclusive) */
  totalActivePercent: number
  /** Total (inclusive) time in milliseconds, computed from timeDeltas */
  totalMs: number
}

const IDLE_NAMES = new Set(['(idle)', '(garbage collector)', '(program)', '(root)'])

/** Full metadata associated with an identity key, kept in a side map so we
 * never have to parse the key string back into its components. */
interface IdentityMeta {
  functionName: string
  url: string
  scriptId: string
  lineNumber: number
  columnNumber: number
}

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

  // Cache identity key + metadata per node id. Computed once per node so the
  // hot sample-walk loop below only does a Map lookup instead of rebuilding
  // the string. Also lets us grab the full callFrame metadata later without
  // parsing the key back.
  const identityByNodeId = new Map<number, { key: string; meta: IdentityMeta }>()
  const metaByKey = new Map<string, IdentityMeta>()
  for (const node of profile.nodes) {
    const { functionName, url, scriptId, lineNumber, columnNumber } = node.callFrame
    // JSON.stringify so the key cannot collide with function names containing
    // separator characters. Only fields that disambiguate identity are in the
    // key — url is stored in meta for display only since scriptId already
    // uniquely identifies the script within a single profile.
    const key = JSON.stringify([functionName, scriptId, lineNumber, columnNumber])
    const meta: IdentityMeta = { functionName, url, scriptId, lineNumber, columnNumber }
    identityByNodeId.set(node.id, { key, meta })
    if (!metaByKey.has(key)) {
      metaByKey.set(key, meta)
    }
  }

  // Pre-compute per-sample time in microseconds from timeDeltas.
  // timeDeltas[i] is the time between sample i-1 and sample i (in µs).
  // For the first sample we use timeDeltas[0] if available, otherwise
  // fall back to the average delta across all samples.
  const deltas = profile.timeDeltas
  const totalDurationUs = profile.endTime - profile.startTime
  const avgDeltaUs = profile.samples.length > 0
    ? totalDurationUs / profile.samples.length
    : 0
  function sampleDeltaUs(i: number): number {
    if (deltas && i < deltas.length) return deltas[i]!
    return avgDeltaUs
  }

  // Self-time per identity. Each sample contributes to exactly one leaf node
  // so summing by identity can never exceed sampleCount.
  const selfByIdentity = new Map<string, number>()
  const selfUsByIdentity = new Map<string, number>()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]!
    const entry = identityByNodeId.get(id)
    if (!entry) continue
    selfByIdentity.set(entry.key, (selfByIdentity.get(entry.key) || 0) + 1)
    selfUsByIdentity.set(entry.key, (selfUsByIdentity.get(entry.key) || 0) + sampleDeltaUs(i))
  }

  // Total-time (inclusive) per identity. For each sample, walk from the
  // sampled leaf up to root and increment each identity AT MOST ONCE per
  // sample — so a function that appears on every active sample's stack tops
  // out at exactly nonIdleSamples, giving %Total <= 100%.
  const totalByIdentity = new Map<string, number>()
  const totalUsByIdentity = new Map<string, number>()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]!
    const deltaUs = sampleDeltaUs(i)
    const visitedNodes = new Set<number>()          // defensive — break node-level cycles
    const visitedIdentities = new Set<string>()     // per-sample identity dedup
    let current: number | undefined = id
    while (current !== undefined) {
      if (visitedNodes.has(current)) break
      visitedNodes.add(current)
      const entry = identityByNodeId.get(current)
      if (entry && !visitedIdentities.has(entry.key)) {
        visitedIdentities.add(entry.key)
        totalByIdentity.set(entry.key, (totalByIdentity.get(entry.key) || 0) + 1)
        totalUsByIdentity.set(entry.key, (totalUsByIdentity.get(entry.key) || 0) + deltaUs)
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

  // Build FunctionStat entries from the per-identity maps using metaByKey
  // for the source callFrame info. Never parse the key string back.
  const functions: FunctionStat[] = []
  const allKeys = new Set<string>([
    ...selfByIdentity.keys(),
    ...totalByIdentity.keys(),
  ])
  for (const key of allKeys) {
    const meta = metaByKey.get(key)
    if (!meta) continue
    if (IDLE_NAMES.has(meta.functionName)) continue
    const self = selfByIdentity.get(key) || 0
    const total = totalByIdentity.get(key) || 0
    if (self === 0 && total === 0) continue
    functions.push({
      functionName: meta.functionName || '(anonymous)',
      url: meta.url,
      scriptId: meta.scriptId,
      lineNumber: meta.lineNumber,
      columnNumber: meta.columnNumber,
      selfSamples: self,
      selfPercent: sampleCount > 0 ? (self / sampleCount) * 100 : 0,
      activePercent: nonIdleSamples > 0 ? (self / nonIdleSamples) * 100 : 0,
      selfMs: (selfUsByIdentity.get(key) || 0) / 1000,
      totalSamples: total,
      totalPercent: sampleCount > 0 ? (total / sampleCount) * 100 : 0,
      totalActivePercent: nonIdleSamples > 0 ? (total / nonIdleSamples) * 100 : 0,
      totalMs: (totalUsByIdentity.get(key) || 0) / 1000,
    })
  }

  functions.sort((a, b) => (b.selfMs - a.selfMs) || (b.selfSamples - a.selfSamples))

  const durationSeconds = (profile.endTime - profile.startTime) / 1e6

  return { durationSeconds, totalSamples: sampleCount, nonIdleSamples, functions }
}
