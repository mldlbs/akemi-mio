import { useState, useEffect } from 'react'
import { useIPCEvent } from './useIPCEvent'

export interface OtparEntry {
  type: 'observe' | 'think' | 'reflect'
  requestId: string
  step: number
  durationMs?: number
  timestamp: number
  detail: string
}

interface PlanStepData {
  id: string
  description: string
  status: string
  result?: string
}

interface PlanData {
  id: string
  title: string
  description: string
  steps: PlanStepData[]
  status: string
  createdAt: number
  updatedAt: number
}

export function usePlans() {
  const [activePlan, setActivePlan] = useState<PlanData | null>(null)
  const [planHistory, setPlanHistory] = useState<PlanData[]>([])
  const [otparStages, setOtparStages] = useState<OtparEntry[]>([])

  // Load initial data
  useEffect(() => {
    window.electronAPI.getActivePlan().then((plan) => setActivePlan(plan))
    window.electronAPI.listPlans().then((list) => {
      setPlanHistory(list.filter((p) => p.status !== 'active'))
    })
  }, [])

  // Subscribe to plan events
  useIPCEvent(window.electronAPI.onPlanCreated, (_data: { planId: string; title: string }) => {
    window.electronAPI.getActivePlan().then((plan) => setActivePlan(plan))
    window.electronAPI.listPlans().then((list) => {
      setPlanHistory(list.filter((p) => p.status !== 'active'))
    })
  })

  useIPCEvent(window.electronAPI.onPlanStep, (data: { planId: string; stepIndex: number; status: string }) => {
    setActivePlan((prev) => {
      if (!prev || prev.id !== data.planId) return prev
      return {
        ...prev,
        steps: prev.steps.map((s, i) => (i === data.stepIndex ? { ...s, status: data.status } : s)),
      }
    })
  })

  useIPCEvent(window.electronAPI.onPlanCompleted, (data: { planId: string }) => {
    setActivePlan((prev) => {
      if (!prev || prev.id !== data.planId) return prev
      return { ...prev, status: 'completed' }
    })
    window.electronAPI.listPlans().then((list) => {
      setPlanHistory(list.filter((p) => p.status !== 'active'))
    })
  })

  // Subscribe to OTPAR stages — keep last 20
  useIPCEvent(
    window.electronAPI.onAgentObserve,
    (data: { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }) => {
      setOtparStages((prev) => [
        ...prev.slice(-19),
        {
          type: 'observe' as const,
          requestId: data.requestId,
          step: data.step,
          durationMs: data.durationMs,
          timestamp: Date.now(),
          detail: `流程 ${data.proceduresFound} · 模式 ${data.patternsFound}`,
        },
      ])
    },
  )

  useIPCEvent(
    window.electronAPI.onAgentThink,
    (data: { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }) => {
      setOtparStages((prev) => [
        ...prev.slice(-19),
        {
          type: 'think' as const,
          requestId: data.requestId,
          step: data.step,
          timestamp: Date.now(),
          detail: `${data.toolCallCount} 个工具` + (data.strategyPrompted ? ' · 策略提示' : ''),
        },
      ])
    },
  )

  useIPCEvent(
    window.electronAPI.onAgentReflect,
    (data: { requestId: string; step: number; toolResults: number; successCount: number; summary: string; durationMs: number }) => {
      setOtparStages((prev) => [
        ...prev.slice(-19),
        {
          type: 'reflect' as const,
          requestId: data.requestId,
          step: data.step,
          durationMs: data.durationMs,
          timestamp: Date.now(),
          detail: data.summary,
        },
      ])
    },
  )

  return { activePlan, planHistory, otparStages }
}
