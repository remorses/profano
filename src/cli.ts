#!/usr/bin/env node
// profano — CLI tool to analyze .cpuprofile files and print top functions
// by self-time or total-time in the terminal. Designed for AI agents and
// humans who want quick profiling insights without opening a browser.

import { goke } from 'goke'
import { z } from 'zod'
import { globSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadProfile, analyze } from './parse.ts'
import { formatTable, type SortMode } from './format.ts'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json') as { version: string }

const cli = goke('profano')

cli
  .command('<files...>', 'Analyze .cpuprofile files and print top functions')
  .option(
    '-n, --limit [limit]',
    z.number().default(30).describe('Number of top functions to show'),
  )
  .option(
    '-s, --sort [sort]',
    z.enum(['self', 'total']).default('self').describe('Sort by self-time or total/inclusive time'),
  )
  .example('# Analyze a single profile (sorted by self-time)')
  .example('profano ./tmp/cpu-profiles/CPU.*.cpuprofile')
  .example('# Sort by total/inclusive time')
  .example('profano profile.cpuprofile --sort total')
  .example('# Show top 50 functions')
  .example('profano profile.cpuprofile -n 50')
  .action((files, options) => {
    // goke variadic args can be string[] or string depending on input
    const fileList: string[] = Array.isArray(files) ? files : [files]

    // Expand globs if shell didn't
    const resolved: string[] = fileList.flatMap((f: string) => {
      if (f.includes('*')) {
        const matches = globSync(f)
        return matches.length > 0 ? matches : [f]
      }
      return [f]
    })

    if (resolved.length === 0) {
      console.error('No .cpuprofile files found')
      process.exit(1)
    }

    const sort = options.sort as SortMode

    for (const filePath of resolved) {
      if (resolved.length > 1) {
        console.log(`\n━━━ ${filePath} ━━━\n`)
      }

      const profile = loadProfile(filePath)
      const result = analyze(profile)
      console.log(formatTable({ ...result, limit: options.limit, sort }))
    }
  })

cli.help()
cli.version(packageJson.version)
cli.parse()
