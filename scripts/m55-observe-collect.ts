#!/usr/bin/env tsx
import { resolve } from 'path'

import { collectObservationSamples } from '@akemi-mio/intelligence/mcp/MemoryObservationCollector'

type CliOptions = {
  days: number
  limit: number
  samples: number
  intervalMinutes: number
  outDir: string
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = await collectObservationSamples({
    ...options,
    outDir: resolve(process.cwd(), options.outDir),
    projectRoot: process.cwd(),
  })

  console.log('============================================================')
  console.log('M5.5 Observation Collector')
  console.log(`Generated at: ${new Date().toISOString()}`)
  console.log(`Output dir: ${result.outDir}`)
  console.log(`Samples collected: ${result.entries.length}`)
  console.log(`Latest file: ${result.entries[result.entries.length - 1]?.fileName ?? 'n/a'}`)
  console.log('============================================================')
  for (const entry of result.entries) {
    console.log(`${entry.capturedAt} -> ${entry.relativePath}`)
  }
}

function parseArgs(args: string[]): CliOptions {
  let days = 1
  let limit = 500
  let samples = 1
  let intervalMinutes = 360
  let outDir = 'reports/m55'

  for (const arg of args) {
    if (arg.startsWith('--days=')) {
      days = Number(arg.slice('--days='.length)) || days
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length)) || limit
    } else if (arg.startsWith('--samples=')) {
      samples = Number(arg.slice('--samples='.length)) || samples
    } else if (arg.startsWith('--interval-minutes=')) {
      intervalMinutes = Number(arg.slice('--interval-minutes='.length)) || intervalMinutes
    } else if (arg.startsWith('--out-dir=')) {
      outDir = arg.slice('--out-dir='.length) || outDir
    }
  }

  return { days, limit, samples, intervalMinutes, outDir }
}

main().catch((error) => {
  console.error('M5.5 observation collection failed:')
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
