import type { Message } from '../agent/context'
import type { ToolResult } from '../agent/ToolScheduler'
import { log } from '../logger/Logger'

function isEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.AKEMI_MIO_OBSERVABILITY === '1'
}

interface LogEntry {
  tag: string
  body: string
}

export class ObservabilityLogger {
  private entries: LogEntry[] = []

  constructor(private requestId: string) {}

  get enabled(): boolean {
    return isEnabled()
  }

  logInput(text: string, source: string): void {
    if (!isEnabled()) return
    this.entries.push({ tag: 'INPUT', body: text || '(empty)' })
  }

  logMemory(query: string, hitCount: number): void {
    if (!isEnabled()) return
    this.entries.push({
      tag: 'MEMORY',
      body: `query: "${query || '(empty)'}"\nhit_count: ${hitCount}`,
    })
  }

  logPrompt(messages: Message[]): void {
    if (!isEnabled()) return
    const parts: string[] = []
    for (const m of messages) {
      const role = m.role.padEnd(9)
      let content = ''
      if (m.role === 'system') {
        content = m.content || '(empty)'
      } else if (m.role === 'tool') {
        content = (m.content || '(empty)').slice(0, 200)
      } else {
        content = (m.content || '(empty)').slice(0, 500)
      }
      if (m.tool_calls?.length) {
        content += ` [tool_calls: ${m.tool_calls.map((t) => t.name).join(', ')}]`
      }
      parts.push(`  [${role}] ${content}`)
    }
    const joined = parts.join('\n')
    this.entries.push({
      tag: 'PROMPT',
      body: joined.length > 30_000 ? joined.slice(0, 30_000) + '\n  ... [truncated]' : joined,
    })
  }

  logToolBatch(results: ToolResult[]): void {
    if (!isEnabled()) return
    const lines = results.map(
      (r) =>
        `  ${r.name} → ${r.success ? 'success' : 'fail'}${r.error ? `  error: ${r.error.slice(0, 200)}` : ''}${r.success ? `  (${r.latencyMs}ms)` : ''}`,
    )
    this.entries.push({
      tag: 'TOOL',
      body: lines.length ? lines.join('\n') : '(no tools)',
    })
  }

  logOutput(text: string, durationMs: number): void {
    if (!isEnabled()) return
    this.entries.push({
      tag: 'OUTPUT',
      body: `${text || '(empty)'} (${durationMs}ms)`,
    })
  }

  /** 记录提前退出的原因（return '' 路径标记） */
  logExit(reason: string, detail?: string): void {
    if (!isEnabled()) return
    const tag = `EXIT:${reason}`
    this.entries.push({ tag, body: detail || '' })
    log('WARN', 'chat_exit', { requestId: this.requestId, reason, detail })
  }

  /** 记录 LLM 调用断点 */
  logLlmTrace(phase: 'before' | 'after' | 'result', payload: string): void {
    if (!isEnabled()) return
    log('INFO', 'llm_trace', { requestId: this.requestId, phase, payload })
  }

  flush(): void {
    if (!isEnabled() || !this.entries.length) return
    const block = this.entries.map((e) => `${e.tag}:\n${e.body}`).join('\n\n')
    const sep = '━'.repeat(8)
    const msg = `${sep} Request ${this.requestId} ${sep}\n${block}\n${sep}${'━'.repeat(20)}`
    console.log(msg)
    // 写入 JSON 日志文件方便检索
    const summary = this.entries.map((e) => `${e.tag}=${e.body.slice(0, 80).replace(/\n/g, ' ')}`).join(' | ')
    log('INFO', 'observability', { requestId: this.requestId, summary })
    // 同步写入独立 obs 日志文件，确保不丢失
    try {
      const fs = require('fs')
      const os = require('os')
      const p = require('path')
      const home = os.homedir ? os.homedir() : process.env.USERPROFILE || ''
      if (home) {
        const obsPath = p.join(home, '.akemi-obs.log')
        fs.appendFileSync(obsPath, msg + '\n', 'utf-8')
      }
    } catch {}
    this.entries.length = 0
  }
}
