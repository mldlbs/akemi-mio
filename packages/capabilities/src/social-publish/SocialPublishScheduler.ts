import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '@akemi-mio/core/config'
import { log } from '@akemi-mio/core/logger/Logger'
import type { ICapabilityService } from '../capability/types'
import type { TaskExecutionResult } from '@akemi-mio/core/core/tasks/unified/TaskTypes'
import { SOCIAL_PLATFORMS } from './SocialPublishService'
import { loadSocialConfig } from './socialConfig'

/**
 * SocialPublishScheduler — 社交排程调度器（Phase 2）
 *
 * 取代 AppRuntime 里 `node social/cli.mjs tick` 的 spawn：
 * 1. 读 content_calendar.yaml，筛出到期的 scheduled 项；
 * 2. 过门禁（平台启用 / mode / 平台白名单）；
 * 3. capabilityService.resolve('publishing') + invoke（走 social_publish 工具）；
 * 4. 结果回写排程（published / failed / cancelled）。
 *
 * 日历格式与 social/workflows/cli.mjs 的 parseCalendar/serializeCalendar 兼容，
 * 保证 CLI 的 list / confirm 命令可继续读写同一文件。
 */

interface CalendarItem {
  scheduledAt?: string
  draft?: string
  text?: string
  platform?: string
  title?: string
  topics?: string[]
  replyToId?: string
  status?: string
  postId?: string
  publishedAt?: number
  _error?: string
}

export interface SchedulerTickResult {
  posted: number
  skipped: number
  errors: number
  cancelled: number
  details: Array<{ platform: string; title?: string; status: string; reason?: string }>
}

function isDue(scheduledAt: string | undefined, now: number): boolean {
  if (!scheduledAt) return false
  const t = new Date(scheduledAt).getTime()
  return !Number.isNaN(t) && t <= now
}

// ===== 日历解析 / 序列化（与 cli.mjs 格式兼容） =====

function parseCalendar(raw: string): { scheduled: CalendarItem[]; published: CalendarItem[] } {
  const scheduled: CalendarItem[] = []
  const published: CalendarItem[] = []
  let current: CalendarItem | null = null
  let section: 'scheduled' | 'published' | null = null

  const pushCurrent = () => {
    if (!current) return
    if (section === 'published') published.push(current)
    else scheduled.push(current)
    current = null
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === 'scheduled:') {
      pushCurrent()
      section = 'scheduled'
      continue
    }
    if (trimmed === 'published:') {
      pushCurrent()
      section = 'published'
      continue
    }
    if (line.startsWith('  - scheduledAt:')) {
      pushCurrent()
      if (!section) section = 'scheduled'
      current = {
        scheduledAt: line.split(/:\s*/).slice(1).join(':').trim().replace(/"/g, ''),
        status: section === 'published' ? 'published' : 'scheduled',
      }
      continue
    }
    if (!current || !section) continue
    const m = line.match(/^ {4}(\w+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (key === 'draft') {
      current.draft = val.replace(/^"(.*)"$/, '$1')
      continue
    }
    val = val
      .replace(/^"(.*)"$/, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
    if (val.startsWith('[')) {
      try {
        val = JSON.parse(val.replace(/'/g, '"'))
      } catch {
        /* 保留原文 */
      }
    }
    ;(current as Record<string, unknown>)[key] = val
  }
  pushCurrent()
  return { scheduled, published }
}

function serializeCalendar(scheduled: CalendarItem[], published: CalendarItem[]): string {
  const yq = (s: string | undefined): string => {
    if (!s) return s ?? ''
    return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
  }
  const kv = (indent: number, key: string, val: unknown): string => {
    if (val === undefined || val === null || val === '') return ''
    return ' '.repeat(indent) + key + ': ' + String(val) + '\n'
  }
  const emit = (items: CalendarItem[]): string => {
    let out = ''
    for (const item of items) {
      out += '  - scheduledAt: "' + (item.scheduledAt ?? '') + '"\n'
      if (item.draft) out += kv(4, 'draft', '"' + yq(item.draft) + '"')
      else out += kv(4, 'text', '"' + yq(item.text) + '"')
      out += '    platform: "' + yq(item.platform ?? '') + '"\n'
      if (item.title) out += kv(4, 'title', '"' + yq(item.title) + '"')
      if (item.topics && item.topics.length) out += kv(4, 'topics', '[' + item.topics.map((t) => JSON.stringify(t)).join(', ') + ']')
      out += '    status: ' + (item.status ?? 'scheduled') + '\n'
      if (item.postId != null) out += kv(4, 'postId', String(item.postId))
      if (item.publishedAt != null) out += kv(4, 'publishedAt', String(item.publishedAt))
    }
    return out
  }
  return (
    '# 内容排程索引\n# draft: drafts/<platform>/<file>.md 查看完整内容\n\nscheduled:\n' +
    emit(scheduled) +
    '\npublished:\n' +
    emit(published)
  )
}

// ===== 草稿内容加载（与 cli.mjs loadDraftContent 对齐） =====

function loadDraftContent(socialDir: string, item: CalendarItem): { text: string; title: string; topics: string[] } {
  if (item.text) return { text: item.text, title: item.title ?? '', topics: item.topics ?? [] }
  if (!item.draft) return { text: '', title: '', topics: [] }
  const draftPath = join(socialDir, item.draft)
  if (!existsSync(draftPath)) return { text: '', title: '', topics: [] }
  let raw = readFileSync(draftPath, 'utf-8')
  const titleMatch = raw.match(/^\*\*标题\*\*：(.+)$/m)
  const title = titleMatch ? titleMatch[1].trim() : item.title || ''
  const tagMatch = raw.match(/^\*\*话题标签\*\*：(.*)$/m)
  const topics = tagMatch
    ? tagMatch[1]
        .split(/[#，,、]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : item.topics || []
  raw = raw
    .replace(/^---[\s\S]*?---\n*/m, '')
    .replace(/^# .+\n+/m, '')
    .replace(/^- \*\*排程\*\*.*\n+/gm, '')
    .replace(/^- \*\*标题\*\*.*\n+/gm, '')
    .replace(/^- \*\*话题标签\*\*.*\n+/gm, '')
    .replace(/^## 文案\n+/m, '')
    .trim()
  return { text: raw, title, topics }
}

// ===== 调度器 =====

export class SocialPublishScheduler {
  private readonly socialDir: string
  private readonly now: () => number

  constructor(
    private readonly capabilityService: ICapabilityService,
    options: { socialDir?: string; now?: () => number } = {},
  ) {
    this.socialDir = options.socialDir ?? join(WORKSPACE.evolution, 'social')
    this.now = options.now ?? Date.now
  }

  /** TaskRunner 执行入口 */
  async tick(): Promise<TaskExecutionResult> {
    try {
      const result = await this.runOnce()
      if (result.posted > 0 || result.errors > 0 || result.cancelled > 0) {
        log('INFO', 'social_tick', {
          posted: result.posted,
          skipped: result.skipped,
          errors: result.errors,
          cancelled: result.cancelled,
        })
      }
      return { success: true, summary: JSON.stringify(result) }
    } catch (err: any) {
      log('WARN', 'social_tick_error', { error: String(err) })
      return { success: false, summary: String(err) }
    }
  }

  /** 单轮调度逻辑（可测试） */
  async runOnce(): Promise<SchedulerTickResult> {
    const calendarPath = join(this.socialDir, 'config', 'content_calendar.yaml')
    if (!existsSync(calendarPath)) return { posted: 0, skipped: 0, errors: 0, cancelled: 0, details: [] }

    const raw = readFileSync(calendarPath, 'utf-8')
    const cal = parseCalendar(raw)
    const config = loadSocialConfig(this.socialDir)
    const now = this.now()

    const due = cal.scheduled.filter((item) => item.status === 'scheduled' && isDue(item.scheduledAt, now))
    const notDue = cal.scheduled.filter((item) => !due.includes(item))
    const stillScheduled: CalendarItem[] = []
    const toPublished: CalendarItem[] = []
    const result: SchedulerTickResult = { posted: 0, skipped: 0, errors: 0, cancelled: 0, details: [] }

    for (const item of due) {
      const platform = item.platform || ''
      if (!platform) {
        item.status = 'failed'
        item._error = '缺少 platform 字段'
        result.errors++
        result.details.push({ platform, status: 'failed', reason: item._error })
        toPublished.push(item)
        continue
      }
      if (!SOCIAL_PLATFORMS.includes(platform as (typeof SOCIAL_PLATFORMS)[number])) {
        item.status = 'failed'
        item._error = `未知平台 ${platform}`
        result.errors++
        result.details.push({ platform, status: 'failed', reason: item._error })
        toPublished.push(item)
        continue
      }

      const content = loadDraftContent(this.socialDir, item)
      if (!content.text.trim()) {
        result.skipped++
        result.details.push({ platform, title: item.title, status: 'skipped', reason: 'empty_content' })
        stillScheduled.push(item)
        continue
      }

      // 门禁：平台启用 + mode
      const platformCfg = config.platforms[platform]
      if (platformCfg && platformCfg.enabled === false) {
        result.skipped++
        result.details.push({ platform, title: item.title, status: 'skipped', reason: 'platform_disabled' })
        stillScheduled.push(item)
        continue
      }
      if (config.mode === 'safe') {
        result.skipped++
        result.details.push({ platform, title: item.title, status: 'skipped', reason: 'mode_safe' })
        stillScheduled.push(item)
        continue
      }

      try {
        await this.publish(item, content)
        if (item.status === 'published') result.posted++
        else if (item.status === 'cancelled') result.cancelled++
        else result.errors++
        result.details.push({ platform, title: item.title, status: item.status ?? 'unknown', reason: item._error })
        toPublished.push(item)
      } catch (err: any) {
        item.status = 'failed'
        item._error = err.message || String(err)
        result.errors++
        result.details.push({ platform, title: item.title, status: 'failed', reason: item._error })
        toPublished.push(item)
      }
    }

    writeFileSync(calendarPath, serializeCalendar([...notDue, ...stillScheduled], [...cal.published, ...toPublished]), 'utf-8')
    return result
  }

  private async publish(item: CalendarItem, content: { text: string; title: string; topics: string[] }): Promise<void> {
    const binding = await this.capabilityService.resolve('publishing')
    if (!binding) {
      item.status = 'failed'
      item._error = 'publishing 能力不可用（resolve 失败）'
      return
    }
    const output = await this.capabilityService.invoke(binding, {
      platform: item.platform,
      content: content.text,
      title: content.title || item.title || '',
      ...(item.replyToId ? { replyToId: item.replyToId } : {}),
    })
    const data = typeof output === 'string' ? JSON.parse(output) : (output as Record<string, any>)
    if (data.status === 'published') {
      item.status = 'published'
      item.postId = data.postId ?? ''
      item.publishedAt = this.now()
    } else if (data.status === 'requires_review') {
      item.status = 'cancelled'
      item._error = 'requires_review'
    } else if (data.status === 'blocked') {
      item.status = 'cancelled'
      item._error = `blocked:${data.mode ?? ''}/${data.action ?? ''}`
    } else {
      item.status = 'failed'
      item._error = data.error ?? 'publishing 返回未知状态'
    }
  }
}

