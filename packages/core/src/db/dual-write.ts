import { log } from '@akemi-mio/core/logger/Logger'

export interface DualWriteConfig {
  label: string
  writeDb: () => void
  writeJson: () => void
  countDb: () => number
  countJson: () => number
}

export class DualWriteHelper {
  private jsonEnabled = true

  disableJson(): void {
    this.jsonEnabled = false
    log('INFO', 'dual_write_json_disabled')
  }

  write(config: DualWriteConfig): void {
    config.writeDb()
    if (this.jsonEnabled) {
      try {
        config.writeJson()
      } catch (err) {
        log('WARN', 'dual_write_json_failed', { label: config.label, error: String(err) })
      }
    }
  }

  verify(config: DualWriteConfig): boolean {
    const dbCount = config.countDb()
    const jsonCount = config.countJson()
    if (dbCount === jsonCount) {
      log('INFO', 'dual_write_consistent', { label: config.label, dbCount, jsonCount })
      return true
    }
    log('WARN', 'dual_write_inconsistent', { label: config.label, dbCount, jsonCount })
    return false
  }
}

export const dualWrite = new DualWriteHelper()
