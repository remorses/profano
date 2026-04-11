#!/usr/bin/env node
// profano — CLI tool to analyze .cpuprofile files and print top functions
// by self-time or total-time in the terminal. Designed for AI agents and
// humans who want quick profiling insights without opening a browser.

import { goke } from 'goke'
import { z } from 'zod'
import { globSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadProfile, analyze } from './parse.ts'
import { formatTable } from './format.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

const cli = goke('profano')

cli
  .command(
    '[...files]',
    `Analyze one or more V8 .cpuprofile files and print the top functions as a terminal table.

Reads each file, aggregates samples by function identity (name + url + line), drops idle / GC / program / root pseudo-frames, and renders a sortable table with Self and Total (inclusive) sample counts plus their percentage of active (non-idle) samples.

Pass multiple files as separate positional args or a shell glob. profano will also expand globs internally if your shell didn't. Each file is analyzed independently and rendered as its own table; when more than one file is passed a header separator is printed between them.

Use --sort self to find CPU-bound leaves (hot inner functions) and --sort total to find expensive callers that dominate wall time.`,
  )
  .option(
    '-n, --limit [limit]',
    z.int().default(30).describe('Maximum number of top functions to show per profile.'),
  )
  .option(
    '-s, --sort [sort]',
    z
      .enum(['self', 'total'])
      .default('self')
      .describe(
        'Sort by self-time (exclusive, hot leaves) or total-time (inclusive, expensive callers).',
      ),
  )
  .example('# Analyze a single profile (sorted by self-time, default)')
  .example('profano ./tmp/cpu-profiles/CPU.*.cpuprofile')
  .example('# Sort by total/inclusive time to find expensive callers')
  .example('profano profile.cpuprofile --sort total')
  .example('# Show top 50 functions')
  .example('profano profile.cpuprofile -n 50')
  .example('# Analyze many profiles at once (each rendered as its own table)')
  .example('profano tmp/cpu-profiles/*.cpuprofile')
  // NOTE: goke's .action() signature is (...args: any[]) so positional args
  // come back untyped. Option types are inferred from the schemas above and
  // must not be annotated. See goke skill rule 3.
  .action((files: string[], options) => {
    // Expand globs if the shell didn't (quoted pattern, no matches, etc.)
    const resolved: string[] = files.flatMap((f) => {
      if (f.includes('*')) {
        const matches = globSync(f)
        return matches.length > 0 ? matches : [f]
      }
      return [f]
    })

    if (resolved.length === 0) {
      console.error('No .cpuprofile files passed. Run `profano --help` for usage.')
      process.exit(1)
    }

    for (const filePath of resolved) {
      if (resolved.length > 1) {
        console.log(`\n━━━ ${filePath} ━━━\n`)
      }

      const profile = loadProfile(filePath)
      const result = analyze(profile)
      console.log(
        formatTable({ ...result, limit: options.limit, sort: options.sort }),
      )
    }
  })

cli.help()
cli.version(packageJson.version)
cli.parse()
