/**
 * WorkflowTriggerManager — 工作流触发器管理器
 *
 * 自动启动 cron 调度和事件监听，当条件满足时触发工作流运行。
 *
 * 触发类型：
 *   cron:    按 cron 表达式轮询，到点时触发
 *   event:   监听 EventBus 事件，事件到达时触发
 *   manual:  仅手动（不自动调度）
 *   webhook: 预留
 */
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { EventName } from '@akemi-mio/core/core/EventBus'
import { log } from '@akemi-mio/core/logger/Logger'
import { CronMatcher } from './CronMatcher'
import { getWorkflowScheduler } from './WorkflowScheduler'
import { workflowStore } from './WorkflowStoreV2'
import type { WorkflowDef, WorkflowTrigger } from './types'

export class WorkflowTriggerManager {
  private cronTimer: ReturnType<typeof setInterval> | null = null
  private eventUnsubscribers: (() => void)[] = []
  private lastCronCheck = 0
  private running = false

  private readonly CRON_POLL_MS = 60_000

  start(): void {
    if (this.running) return
    this.running = true

    this.registerEventListeners()
    this.startCronPolling()

    log('INFO', 'workflow_trigger_manager_started')
  }

  stop(): void {
    this.running = false

    if (this.cronTimer) {
      clearInterval(this.cronTimer)
      this.cronTimer = null
    }

    for (const unsub of this.eventUnsubscribers) {
      unsub()
    }
    this.eventUnsubscribers = []

    log('INFO', 'workflow_trigger_manager_stopped')
  }

  // ── Cron 调度 ──

  private startCronPolling(): void {
    this.cronTimer = setInterval(() => {
      if (!this.running) return
      this.checkCronTriggers()
    }, this.CRON_POLL_MS)

    this.checkCronTriggers()
  }

  private checkCronTriggers(): void {
    try {
      const now = new Date()
      const defs = workflowStore.listDefinitions()
      const lastCheck = this.lastCronCheck
      this.lastCronCheck = now.getTime()

      for (const def of defs) {
        if (def.enabled === false) continue
        const trigger = def.trigger
        if (!trigger || trigger.type !== 'cron' || !trigger.cron) continue

        try {
          const matcher = new CronMatcher(trigger.cron)
          const currentMinuteKey = getMinuteKey(now)
          const lastCheckMinuteKey = getMinuteKey(new Date(lastCheck))

          if (matcher.match(now) && currentMinuteKey !== lastCheckMinuteKey) {
            this.fireTrigger(def, trigger)
          }
        } catch (err: any) {
          log('WARN', 'workflow_cron_parse_error', { defId: def.id, cron: trigger.cron, error: err.message })
        }
      }
    } catch (err: any) {
      log('ERROR', 'workflow_cron_check_error', { error: err.message })
    }
  }

  // ── 事件触发 ──

  private registerEventListeners(): void {
    try {
      const defs = workflowStore.listDefinitions()

      for (const def of defs) {
        if (def.enabled === false) continue
        const trigger = def.trigger
        if (!trigger || trigger.type !== 'event' || !trigger.event) continue

        const unsub = eventBus.on(trigger.event as EventName, () => {
          if (!this.running) return
          log('INFO', 'workflow_event_triggered', { defId: def.id, event: trigger.event })
          this.fireTrigger(def, trigger)
        })

        this.eventUnsubscribers.push(unsub)
        log('INFO', 'workflow_event_listener_registered', { defId: def.id, event: trigger.event })
      }
    } catch (err: any) {
      log('ERROR', 'workflow_event_register_error', { error: err.message })
    }
  }

  refreshEventListeners(): void {
    for (const unsub of this.eventUnsubscribers) {
      unsub()
    }
    this.eventUnsubscribers = []
    this.registerEventListeners()
  }

  // ── 执行触发 ──

  private fireTrigger(def: WorkflowDef, trigger: WorkflowTrigger): void {
    try {
      const scheduler = getWorkflowScheduler()
      const run = scheduler.startRun(def, trigger.defaultInput)

      log('INFO', 'workflow_auto_triggered', {
        defId: def.id,
        name: def.name,
        triggerType: trigger.type,
        runId: run.runId,
      })
    } catch (err: any) {
      log('ERROR', 'workflow_trigger_fire_error', { defId: def.id, triggerType: trigger.type, error: err.message })
    }
  }
}

function getMinuteKey(date: Date): string {
  return `${date.getHours()}:${date.getMinutes()}`
}
