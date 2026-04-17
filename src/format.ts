// Format profile analysis results as a terminal table and tree views.

import type { FunctionStat, TreeNode } from './parse.ts'

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

// ─── Tree formatter ───────────────────────────────────────────────────────

export interface TreeFormatOptions {
  root: TreeNode
  durationSeconds: number
  totalSamples: number
  nonIdleSamples: number
  /** Hide nodes below this % of active time (default 0) */
  minPercent?: number
  /** Max tree depth to display (default unlimited) */
  maxDepth?: number
  /** Zoom into subtree rooted at this function name */
  focus?: string
}

/** Find the subtree rooted at the first node matching `name` (BFS). */
function findFocus(node: TreeNode, name: string): TreeNode | null {
  if (node.functionName === name) return node
  for (const child of node.children) {
    const found = findFocus(child, name)
    if (found) return found
  }
  return null
}

/** Follow the heaviest child chain from a node, collecting function names
 *  until we reach a leaf or a node above minPercent. Returns the chain
 *  as "→ name [pct%]" segments for collapsed display. */
function collapseChain(node: TreeNode, minPercent: number): string {
  const parts: string[] = []
  let current = node
  while (current.children.length > 0) {
    const heaviest = current.children[0]! // already sorted by totalMs desc
    if (heaviest.totalPercent >= minPercent) break
    parts.push(`${heaviest.functionName} [${heaviest.totalPercent.toFixed(1)}%]`)
    current = heaviest
  }
  return parts.length > 0 ? ' → ' + parts.join(' → ') : ''
}

export function formatTree(opts: TreeFormatOptions): string {
  const {
    durationSeconds,
    totalSamples,
    nonIdleSamples,
    minPercent = 0,
    maxDepth,
    focus,
  } = opts

  let root = opts.root

  // Apply focus — zoom into a subtree
  if (focus) {
    const found = findFocus(root, focus)
    if (!found) {
      return `No function matching "${focus}" found in the call tree.`
    }
    root = found
  }

  const lines: string[] = []

  const idlePct =
    totalSamples > 0
      ? (((totalSamples - nonIdleSamples) / totalSamples) * 100).toFixed(1)
      : '0.0'
  lines.push(`Duration: ${durationSeconds.toFixed(2)}s`)
  lines.push(
    `Samples:  ${nonIdleSamples} active / ${totalSamples} total (${idlePct}% idle)`,
  )
  lines.push('')

  function renderNode(node: TreeNode, prefix: string, isLast: boolean, depth: number) {
    // Build the connector: root has no prefix, children get tree lines
    const connector = depth === 0 ? '' : isLast ? '└── ' : '├── '
    const pctStr = node.totalPercent.toFixed(1).padStart(5)
    const timeStr = formatMs(node.totalMs)
    const loc =
      node.url || node.lineNumber >= 0
        ? '  ' + shortenPath(node.url) + (node.lineNumber >= 0 ? ':' + node.lineNumber : '')
        : ''

    // Check if children are pruned by minPercent — if so, show collapsed chain
    const collapsed = minPercent > 0 ? collapseChain(node, minPercent) : ''

    lines.push(`${prefix}${connector}[${pctStr}% ${timeStr}] ${node.functionName}${collapsed}${loc}`)

    // Stop recursing if at maxDepth
    if (maxDepth !== undefined && depth >= maxDepth) return

    // Filter children by minPercent
    const visibleChildren = node.children.filter((c) => c.totalPercent >= minPercent)

    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ')
    for (let i = 0; i < visibleChildren.length; i++) {
      const child = visibleChildren[i]!
      const childIsLast = i === visibleChildren.length - 1
      renderNode(child, childPrefix, childIsLast, depth + 1)
    }
  }

  renderNode(root, '', true, 0)

  return lines.join('\n')
}
