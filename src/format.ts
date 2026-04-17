// Format profile analysis results as a terminal table and tree views.

import type { FunctionStat, TreeNode } from './parse.ts'
import { bold, cyan, dim, yellow, red, green, gray, white } from './colors.ts'

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

  lines.push(`Duration: ${bold(durationSeconds.toFixed(2) + 's')}`)
  lines.push(`Samples:  ${bold(String(nonIdleSamples))} active / ${String(totalSamples)} total (${dim(idlePct + '% idle')})`)
  lines.push(`Sort:     ${bold(sort)}`)
  lines.push('')
  lines.push(
    dim('   Self  %Self   Self ms    Total  %Total  Total ms  Function                                    Location'),
  )
  lines.push(
    dim('───────  ──────  ───────  ───────  ──────  ────────  ──────────────────────────────────────────  ────────────────────────────────'),
  )

  const shown = sorted.slice(0, limit)
  for (const fn of shown) {
    const self = String(fn.selfSamples).padStart(7)
    const selfPct = colorPercent(fn.activePercent.toFixed(1).padStart(5) + '%', fn.activePercent)
    const selfMs = cyan(formatMs(fn.selfMs).padStart(7))
    const total = String(fn.totalSamples).padStart(7)
    const totalPct = colorPercent(fn.totalActivePercent.toFixed(1).padStart(5) + '%', fn.totalActivePercent)
    const totalMs = cyan(formatMs(fn.totalMs).padStart(8))
    const name = bold(fn.functionName.padEnd(42).slice(0, 42))
    const loc = dim(shortenPath(fn.url) + (fn.lineNumber >= 0 ? ':' + fn.lineNumber : ''))
    lines.push(`${self}  ${selfPct}  ${selfMs}  ${total}  ${totalPct}  ${totalMs}  ${name}  ${loc}`)
  }

  if (functions.length > limit) {
    lines.push(dim(`  ... and ${functions.length - limit} more functions`))
  }

  return lines.join('\n')
}

/** Color a percentage string based on how hot it is */
function colorPercent(str: string, pct: number): string {
  if (pct >= 30) return red(str)
  if (pct >= 10) return yellow(str)
  if (pct >= 1) return white(str)
  return dim(str)
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

/** Find the shallowest node matching `name` via level-by-level BFS.
 *  When multiple matches exist at the same shallowest depth, returns
 *  the one with the highest totalMs (hottest). */
function findFocus(root: TreeNode, name: string): TreeNode | null {
  let level = [root]
  while (level.length > 0) {
    const matches = level.filter((n) => n.functionName === name)
    if (matches.length > 0) {
      return matches.reduce((best, n) => (n.totalMs > best.totalMs ? n : best))
    }
    level = level.flatMap((n) => n.children)
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
    parts.push(`${heaviest.functionName} ${dim('[' + heaviest.totalPercent.toFixed(1) + '%]')}`)
    current = heaviest
  }
  return parts.length > 0 ? dim(' → ') + parts.join(dim(' → ')) : ''
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
  lines.push(`Duration: ${bold(durationSeconds.toFixed(2) + 's')}`)
  lines.push(
    `Samples:  ${bold(String(nonIdleSamples))} active / ${String(totalSamples)} total (${dim(idlePct + '% idle')})`,
  )
  lines.push('')

  function renderNode(node: TreeNode, prefix: string, isLast: boolean, depth: number) {
    // Compact connectors: ├ / └ with no trailing spaces, │ for continuation
    const connector = depth === 0 ? '' : dim(isLast ? '└' : '├')
    const pctStr = node.totalPercent.toFixed(1).padStart(5)
    const timeStr = formatMs(node.totalMs)
    const badge = `${dim('[')}${colorPercent(pctStr + '%', node.totalPercent)} ${colorPercent(timeStr, node.totalPercent)}${dim(']')}`
    const loc =
      node.url || node.lineNumber >= 0
        ? ' ' + dim(shortenPath(node.url) + (node.lineNumber >= 0 ? ':' + node.lineNumber : ''))
        : ''

    // Check if children are pruned by minPercent — if so, show collapsed chain
    const collapsed = minPercent > 0 ? collapseChain(node, minPercent) : ''

    const colorName = (s: string) => bold(colorPercent(s, node.totalPercent))
    lines.push(`${prefix}${connector}${badge} ${colorName(node.functionName)}${collapsed}${loc}`)

    // Stop recursing if at maxDepth
    if (maxDepth !== undefined && depth >= maxDepth) return

    // Filter children by minPercent
    const visibleChildren = node.children.filter((c) => c.totalPercent >= minPercent)

    // Compact continuation: │ for non-last, space for last child
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? ' ' : dim('│'))
    for (let i = 0; i < visibleChildren.length; i++) {
      const child = visibleChildren[i]!
      const childIsLast = i === visibleChildren.length - 1
      renderNode(child, childPrefix, childIsLast, depth + 1)
    }
  }

  renderNode(root, '', true, 0)

  return lines.join('\n')
}
