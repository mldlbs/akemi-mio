import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import type { RepeatabilitySummary } from './RepeatabilityAnalyzer'

export class RepeatabilitySummaryWriter {
  constructor(private readonly persistDir: string) {}

  async write(summary: RepeatabilitySummary, fileName = 'repeatability-summary.json'): Promise<string> {
    const outputPath = join(this.persistDir, fileName)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    return outputPath
  }
}
