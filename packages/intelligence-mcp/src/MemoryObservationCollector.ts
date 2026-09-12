import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

export interface ObservationCollectionArgs {
  days: number
  limit: number
}

export interface ObservationCollectionEntry {
  capturedAt: string
  fileName: string
  relativePath: string
}

export interface ObservationCollectionIndex {
  generatedAt: string
  latestFileName: string | null
  samples: ObservationCollectionEntry[]
}

export interface ObservationCollectorOptions extends ObservationCollectionArgs {
  outDir: string
  samples: number
  intervalMinutes: number
  projectRoot?: string
  runObservationImpl?: (args: ObservationCollectionArgs) => Promise<string>
  sleepImpl?: (ms: number) => Promise<void>
  now?: () => Date
}

export interface ObservationCollectionResult {
  outDir: string
  entries: ObservationCollectionEntry[]
  latestFilePath: string
  indexPath: string
}

export async function collectObservationSamples(options: ObservationCollectorOptions): Promise<ObservationCollectionResult> {
  const outDir = resolve(options.outDir)
  mkdirSync(outDir, { recursive: true })

  const runObservation = options.runObservationImpl ?? ((args) => runObservationCommand(args, options.projectRoot))
  const sleep = options.sleepImpl ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)))
  const now = options.now ?? (() => new Date())

  const indexPath = join(outDir, 'index.json')
  const latestFilePath = join(outDir, 'latest.txt')
  const index = loadIndex(indexPath)
  const newEntries: ObservationCollectionEntry[] = []

  for (let i = 0; i < options.samples; i++) {
    const capturedAt = now().toISOString()
    const fileName = toSampleFileName(capturedAt)
    const relativePath = fileName
    const output = await runObservation({ days: options.days, limit: options.limit })

    writeFileSync(join(outDir, fileName), output, 'utf8')
    writeFileSync(latestFilePath, output, 'utf8')

    const entry: ObservationCollectionEntry = {
      capturedAt,
      fileName,
      relativePath,
    }
    index.samples.push(entry)
    index.generatedAt = capturedAt
    index.latestFileName = fileName
    newEntries.push(entry)

    writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8')

    if (i < options.samples - 1) {
      await sleep(options.intervalMinutes * 60 * 1000)
    }
  }

  return {
    outDir,
    entries: newEntries,
    latestFilePath,
    indexPath,
  }
}

export function runObservationCommand(
  args: ObservationCollectionArgs,
  projectRoot: string = process.cwd(),
  execFileSyncImpl: typeof execFileSync = execFileSync,
): Promise<string> {
  const tsxCliPath = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const scriptPath = resolve(projectRoot, 'scripts', 'm55-observe.ts')
  const output = execFileSyncImpl(process.execPath, [tsxCliPath, scriptPath, `--days=${args.days}`, `--limit=${args.limit}`], {
    cwd: projectRoot,
    encoding: 'utf8',
  })

  return Promise.resolve(output)
}

function loadIndex(indexPath: string): ObservationCollectionIndex {
  if (!existsSync(indexPath)) {
    return {
      generatedAt: '',
      latestFileName: null,
      samples: [],
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<ObservationCollectionIndex>
    return {
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      latestFileName: typeof parsed.latestFileName === 'string' ? parsed.latestFileName : null,
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
    }
  } catch {
    return {
      generatedAt: '',
      latestFileName: null,
      samples: [],
    }
  }
}

function toSampleFileName(capturedAt: string): string {
  return `${capturedAt.replace(/:/g, '-')}.txt`
}
