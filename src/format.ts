// Format profile analysis results as a terminal table.

import type { FunctionStat } from './parse.ts'

export type SortMode = 'self' | 'total'

/** Shorten file paths for display: strip node_modules prefix, project paths */
export function shortenPath(url: string): string {
  if (!url) {
    return '(native)'
  }
  // Strip to node_modules-relative path
  const nmIndex = url.lastIndexOf('/node_modules/')
  if (nmIndex !== -1) {
    return 'nm/' + url.slice(nmIndex + '/node_modules/'.length)
  }
  // Strip long absolute paths to last 2 segments
  const parts = url.split('/')
  if (parts.length > 3) {
    return parts.slice(-2).join('/')
  }
  return url
}

/** Format milliseconds for display: use ms for < 1000, seconds otherwise. */
function formatMs(ms: number): string {
  if (ms >= 1000) {
    return (ms / 1000).toFixed(2) + 's'
  }
  if (ms >= 1) {
    return ms.toFixed(1) + 'ms'
  }
  if (ms >= 0.01) {
    return ms.toFixed(2) + 'ms'
  }
  return ms > 0 ? '<0.01ms' : '0ms'
}

export function formatTable(opts: {
  functions: FunctionStat[]
  limit: number
  durationSeconds: number
  totalSamples: number
  nonIdleSamples: number
  sort?: SortMode
}): string {
  const { functions, limit, durationSeconds, totalSamples, nonIdleSamples, sort = 'self' } = opts
  const lines: string[] = []

  const idlePct = totalSamples > 0
    ? (((totalSamples - nonIdleSamples) / totalSamples) * 100).toFixed(1)
    : '0.0'

  const sorted = [...functions].sort((a, b) =>
    sort === 'total'
      ? (b.totalMs - a.totalMs) || (b.totalSamples - a.totalSamples)
      : (b.selfMs - a.selfMs) || (b.selfSamples - a.selfSamples),
  )

  lines.push(`Duration: ${durationSeconds.toFixed(2)}s`)
  lines.push(`Samples:  ${nonIdleSamples} active / ${totalSamples} total (${idlePct}% idle)`)
  lines.push(`Sort:     ${sort}`)
  lines.push('')
  lines.push(
    '   Self  %Self   Self ms    Total  %Total  Total ms  Function                                    Location',
  )
  lines.push(
    '───────  ──────  ───────  ───────  ──────  ────────  ──────────────────────────────────────────  ────────────────────────────────',
  )

  const shown = sorted.slice(0, limit)
  for (const fn of shown) {
    const self = String(fn.selfSamples).padStart(7)
    const selfPct = fn.activePercent.toFixed(1).padStart(5) + '%'
    const selfMs = formatMs(fn.selfMs).padStart(7)
    const total = String(fn.totalSamples).padStart(7)
    const totalPct = fn.totalActivePercent.toFixed(1).padStart(5) + '%'
    const totalMs = formatMs(fn.totalMs).padStart(8)
    const name = fn.functionName.padEnd(42).slice(0, 42)
    const loc = shortenPath(fn.url) + (fn.lineNumber >= 0 ? ':' + fn.lineNumber : '')
    lines.push(`${self}  ${selfPct}  ${selfMs}  ${total}  ${totalPct}  ${totalMs}  ${name}  ${loc}`)
  }

  if (functions.length > limit) {
    lines.push(`  ... and ${functions.length - limit} more functions`)
  }

  return lines.join('\n')
}
