#!/usr/bin/env tsx
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

import {
  analyzeMemoryObservation,
  analyzeStoredEventCoverage,
} from '@akemi-mio/intelligence/mcp/MemoryObservationAnalyzer'
import {
  type ObservationMemorySource,
  loadObservedMemories,
} from '@akemi-mio/intelligence/mcp/MemoryObservationDataSource'

type CliOptions = {
  days: number
  limit: number
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000

  const dbPath = join(homedir(), 'AppData', 'Roaming', 'akemi-mio', 'databases', 'main.db')
  if (!existsSync(dbPath)) {
    throw new Error(`main.db not found at ${dbPath}`)
  }

  const memoryLoad = await loadObservedMemories({
    dbPath,
    cutoffMs,
    limit: options.limit,
    projectRoot: process.cwd(),
  })
  const memoryReport = analyzeMemoryObservation(memoryLoad.entries)

  const logEvents = loadRecentLogEvents(cutoffMs)
  const storedCoverage = analyzeStoredEventCoverage(logEvents)

  printReport({
    options,
    memoryReport,
    storedCoverage,
    memoryEntryCount: memoryLoad.entries.length,
    logEventCount: logEvents.length,
    dbPath,
    memorySource: memoryLoad.source,
  })
}

function parseArgs(args: string[]): CliOptions {
  let days = 7
  let limit = 500

  for (const arg of args) {
    if (arg.startsWith('--days=')) {
      days = Number(arg.slice('--days='.length)) || days
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length)) || limit
    }
  }

  return { days, limit }
}

function loadRecentLogEvents(cutoffMs: number): Array<Record<string, unknown>> {
  const candidates = [
    join(homedir(), 'AppData', 'Roaming', 'akemi-mio', 'logs'),
    resolve(process.cwd(), 'logs.txt'),
  ]

  const events: Array<Record<string, unknown>> = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const files = statSync(candidate).isDirectory()
      ? collectLogFiles(candidate)
      : [candidate]

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>
          const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN
          if (Number.isFinite(ts) && ts >= cutoffMs) {
            events.push(parsed)
          }
        } catch {
          // Ignore non-JSON lines.
        }
      }
    }
  }

  return events
}

function collectLogFiles(root: string): string[] {
  const files: string[] = []
  const stack = [root]

  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (entry.name.endsWith('.log') || entry.name === 'logs.txt') {
        files.push(fullPath)
      }
    }
  }

  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

function printReport(input: {
  options: CliOptions
  memoryReport: ReturnType<typeof analyzeMemoryObservation>
  storedCoverage: ReturnType<typeof analyzeStoredEventCoverage>
  memoryEntryCount: number
  logEventCount: number
  dbPath: string
  memorySource: ObservationMemorySource
}) {
  const {
    options,
    memoryReport,
    storedCoverage,
    memoryEntryCount,
    logEventCount,
    dbPath,
    memorySource,
  } = input

  console.log('============================================================')
  console.log('M5.5 Observation Gate')
  console.log(`Generated at: ${new Date().toISOString()}`)
  console.log(`Window: last ${options.days} day(s)`)
  console.log(`Memory sample limit: ${options.limit}`)
  console.log(`main.db: ${dbPath}`)
  console.log(`Memory source: ${memorySource}`)
  console.log('============================================================')
  console.log('')

  console.log('1. Identity Coverage')
  console.log(`  Memory call entries:       ${memoryReport.identityCoverage.totalCallMemories}`)
  console.log(`  Capability-tagged entries: ${memoryReport.identityCoverage.capabilityTaggedMemories}`)
  console.log(`  Memory coverage rate:      ${formatPct(memoryReport.identityCoverage.identityCoverageRate)}`)
  console.log(`  Runtime log events read:   ${logEventCount}`)
  console.log(`  Stored runtime events:     ${storedCoverage.totalStored}`)
  console.log(`  Resolved runtime events:   ${storedCoverage.resolvedStored}`)
  console.log(`  Runtime coverage rate:     ${formatPct(storedCoverage.identityCoverageRate)}`)
  console.log('')

  console.log('2. Retrieval Alignment')
  console.log(`  Query samples:             ${memoryReport.retrievalAlignment.sampleCount}`)
  console.log(`  Old top1 same-capability:  ${formatPct(memoryReport.retrievalAlignment.oldSameCapabilityTop1Rate)}`)
  console.log(`  New top1 same-capability:  ${formatPct(memoryReport.retrievalAlignment.newSameCapabilityTop1Rate)}`)
  console.log(`  Old capability-vs-legacy gap: ${memoryReport.retrievalAlignment.oldAvgCapabilityVsLegacyGap.toFixed(2)}`)
  console.log(`  New capability-vs-legacy gap: ${memoryReport.retrievalAlignment.newAvgCapabilityVsLegacyGap.toFixed(2)}`)
  console.log('')

  console.log('3. Bias Shift')
  console.log(`  Old top1 capability rate:  ${formatPct(memoryReport.biasShift.oldCapabilityTop1Rate)}`)
  console.log(`  New top1 capability rate:  ${formatPct(memoryReport.biasShift.newCapabilityTop1Rate)}`)
  console.log(`  Old top1 legacy rate:      ${formatPct(memoryReport.biasShift.oldLegacyTop1Rate)}`)
  console.log(`  New top1 legacy rate:      ${formatPct(memoryReport.biasShift.newLegacyTop1Rate)}`)
  console.log('')

  console.log('Notes')
  console.log(`  Memory entries analyzed:   ${memoryEntryCount}`)
  console.log('  Retrieval/Bias metrics are computed from recent stored call memories, not vector schema changes.')
  console.log('  Runtime coverage uses recent memory_interceptor_stored log lines when available.')
  if (memorySource === 'sqljs-snapshot') {
    console.log('  Warning: fell back to a sql.js snapshot read; live WAL-backed writes may be under-counted.')
  }
  if (
    memoryReport.identityCoverage.capabilityTaggedMemories === 0 &&
    storedCoverage.resolvedStored === 0
  ) {
    console.log('')
    console.log('Warning')
    console.log('  No capability-aware runtime samples were found in the selected window.')
    console.log('  This usually means the app has not yet generated fresh M5.5 traffic after the new code landed.')
    console.log('  Restart the app on the new build, exercise real tool flows, then re-run this script.')
  }
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

main().catch((error) => {
  console.error('M5.5 observation failed:')
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
