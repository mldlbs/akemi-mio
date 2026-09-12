import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import type { PassiveObservationReport } from './PassiveObservationMonitor'

export class PassiveObservationReviewWriter {
  constructor(private readonly persistDir: string) {}

  async write(report: PassiveObservationReport, fileName = 'passive-review.json'): Promise<string> {
    const outputPath = join(this.persistDir, fileName)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return outputPath
  }
}
