import { BrowserWindow } from 'electron'
import { eventBus, type EventName } from '../core/EventBus'

/**
 * UIBridge — 将 EventBus 事件桥接到 Renderer IPC
 *
 * 职责：
 * - 订阅 Agent 相关 EventBus 事件
 * - 通过 webContents.send 转发到渲染进程
 * - 生命周期与 mainWindow 绑定
 */
export class UIBridge {
  private mainWindow: BrowserWindow | null = null
  private disposers: (() => void)[] = []

  /** 绑定窗口，开始转发 */
  bind(win: BrowserWindow): void {
    this.mainWindow = win
    this.startListening()
  }

  /** 解绑窗口，停止转发 */
  unbind(): void {
    this.mainWindow = null
    for (const d of this.disposers) d()
    this.disposers = []
  }

  private send(channel: string, data: unknown): void {
    this.mainWindow?.webContents.send(channel, data)
  }

  private listen(event: EventName): void {
    const d = eventBus.on(event as any, (payload: any) => {
      const suffix = event
        .replace(/^agent\./, '')
        .replace(/^goal\./, '')
        .replace(/^guardrail\./, '')
      this.send(`agent:${suffix.replace(/\./g, '_')}`, payload)
    })
    this.disposers.push(d)
  }

  private startListening(): void {
    // 工具调用
    this.listen('agent.tool.invoked')
    this.listen('agent.tool.completed')
    this.listen('agent.tool.failed')

    // 计划
    this.listen('agent.plan.created')
    this.listen('agent.plan.step')
    this.listen('agent.plan.completed')

    // OTPAR 阶段
    this.listen('agent.observe')
    this.listen('agent.think')
    this.listen('agent.reflect')

    // 输入输出
    this.listen('agent.input.received')
    this.listen('agent.response.generated')

    // Guardrail 事件 — 用统一 channel 带 type 区分
    const dGuardReadonly = eventBus.on('guardrail.readonly_stuck', (p) => this.send('agent:guardrail', { type: 'readonly_stuck', ...p }))
    this.disposers.push(dGuardReadonly)

    const dGuardTool = eventBus.on('guardrail.tool_error', (p) => this.send('agent:guardrail', { type: 'tool_error', ...p }))
    this.disposers.push(dGuardTool)

    const dGuardGoal = eventBus.on('goal.guardrail.rejection', (p) => this.send('agent:guardrail', { type: 'goal_rejection', ...p }))
    this.disposers.push(dGuardGoal)

    // 预算事件
    const dBudgetEx = eventBus.on('budget.exhausted', (p) => this.send('agent:budgetExhausted', p))
    this.disposers.push(dBudgetEx)

    const dBudgetRest = eventBus.on('budget.restored', (p) => this.send('agent:budgetRestored', p))
    this.disposers.push(dBudgetRest)

    // Agent 错误
    const dError = eventBus.on('agent.error', (p) => this.send('agent:error', p))
    this.disposers.push(dError)

    // 工作流运行事件
    const dWfCreated = eventBus.on('workflow.run.created' as any, (p) => this.send('workflow:run_created', p))
    this.disposers.push(dWfCreated)

    const dWfUpdated = eventBus.on('workflow.run.updated' as any, (p) => this.send('workflow:run_updated', p))
    this.disposers.push(dWfUpdated)

    const dWfStep = eventBus.on('workflow.run.step' as any, (p) => this.send('workflow:run_step', p))
    this.disposers.push(dWfStep)

    // 工作流定义变更 → UI 刷新列表
    const dWfDefCreated = eventBus.on('workflow.def.created' as any, (p) => this.send('workflow:def_created', p))
    this.disposers.push(dWfDefCreated)
  }
}
