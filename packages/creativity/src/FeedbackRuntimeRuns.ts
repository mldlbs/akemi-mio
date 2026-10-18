import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { FEEDBACK_MODES } from './FeedbackRuntime'
import type { FeedbackRuntimeRun } from './FeedbackRollout'

/**
 * feedback-runtime-runs.jsonl 的唯一读写实现（append-only，供放量报告统计阶段门槛）。
 *
 * 双轴共用：CLI/MCP（CreativityEngine）与主进程（CreativityService）都经由本模块落盘，
 * 因此两个入口写入的行格式与读取口径不可能各自漂移（同 memory-store/policy-store 模式）。
 * 数据目录由调用方决定：CLI/MCP 是 `<MIO_HOME>/creativity`，主进程是
 * `MIO_HOME/creativity`（未设置时回退 `WORKSPACE_ROOT/creativity`）。
 */
export const FEEDBACK_RUNTIME_RUNS_FILE = 'feedback-runtime-runs.jsonl'

/** 追加一条观测运行摘要。落盘失败由调用方 best-effort 兜底（不得阻断生成）。 */
export function recordFeedbackRuntimeRun(dir: string, run: FeedbackRuntimeRun): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, FEEDBACK_RUNTIME_RUNS_FILE), JSON.stringify(run) + '\n', 'utf8')
}

/** 读取全部观测运行摘要。损坏行/非对象行/`off` 行跳过（同 JsonlFeedbackEventStore 策略）。 */
export function readFeedbackRuntimeRuns(dir: string): FeedbackRuntimeRun[] {
  const file = join(dir, FEEDBACK_RUNTIME_RUNS_FILE)
  if (!existsSync(file)) return []
  const out: FeedbackRuntimeRun[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (
        row &&
        typeof row === 'object' &&
        typeof row.mode === 'string' &&
        row.mode !== 'off' &&
        FEEDBACK_MODES.includes(row.mode)
      ) {
        out.push({
          at: Number(row.at) || 0,
          mode: row.mode,
          snapshotVersion: typeof row.snapshotVersion === 'string' ? row.snapshotVersion : null,
          pairCount: Number(row.pairCount) || 0,
          applied: !!row.applied,
        })
      }
    } catch (_) {
      // 损坏行跳过
    }
  }
  return out
}
