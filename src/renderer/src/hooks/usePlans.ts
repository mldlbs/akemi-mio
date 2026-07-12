import { useEffect } from 'react'
import { useIPCEvent } from './useIPCEvent'
import { usePlansStore } from '../store/plansStore'

export type { OtparEntry } from '../store/plansStore'

export function usePlans() {
  const store = usePlansStore()

  // Load initial data
  useEffect(() => {
    window.electronAPI.getActivePlan().then((plan) => store.setActivePlan(plan))
    window.electronAPI.listPlans().then((list) => {
      store.setPlanHistory(list.filter((p) => p.status !== 'active'))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribe to plan events
  useIPCEvent(window.electronAPI?.onPlanCreated, () => {
    window.electronAPI.getActivePlan().then((plan) => store.setActivePlan(plan))
    window.electronAPI.listPlans().then((list) => {
      store.setPlanHistory(list.filter((p) => p.status !== 'active'))
    })
  })

  useIPCEvent(window.electronAPI?.onPlanStep, (data: { planId: string; stepIndex: number; status: string }) => {
    store.updateActivePlanStep(data.stepIndex, data.status)
  })

  useIPCEvent(window.electronAPI?.onPlanCompleted, () => {
    store.completeActivePlan()
    window.electronAPI.listPlans().then((list) => {
      store.setPlanHistory(list.filter((p) => p.status !== 'active'))
    })
  })

  // Subscribe to OTPAR stages — keep last 20
  useIPCEvent(
    window.electronAPI?.onAgentObserve,
    (data: { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }) => {
      store.addOtparStage({
        type: 'observe',
        requestId: data.requestId,
        step: data.step,
        durationMs: data.durationMs,
        timestamp: Date.now(),
        detail: `流程 ${data.proceduresFound} · 模式 ${data.patternsFound}`,
      })
    },
  )

  useIPCEvent(
    window.electronAPI?.onAgentThink,
    (data: { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }) => {
      store.addOtparStage({
        type: 'think',
        requestId: data.requestId,
        step: data.step,
        timestamp: Date.now(),
        detail: `${data.toolCallCount} 个工具` + (data.strategyPrompted ? ' · 策略提示' : ''),
      })
    },
  )

  useIPCEvent(
    window.electronAPI?.onAgentReflect,
    (data: { requestId: string; step: number; toolResults: number; successCount: number; summary: string; durationMs: number }) => {
      store.addOtparStage({
        type: 'reflect',
        requestId: data.requestId,
        step: data.step,
        durationMs: data.durationMs,
        timestamp: Date.now(),
        detail: data.summary,
      })
    },
  )

  return {
    activePlan: store.activePlan,
    planHistory: store.planHistory,
    otparStages: store.otparStages,
  }
}
