/**
 * PlanProgressWidget — 计划进度面板
 *
 * 在监控面板区域或空闲面板显示当前 TypeScript 学习计划的进度。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 组件
// =============================================================================

function PlanProgressPanel({ monitoring }: WallpaperWidgetContext) {
  const plan = monitoring?.plan
  if (!plan || !plan.hasActivePlan) return null

  return (
    <div className="wp-plan-panel">
      <div className="wp-plan-title" title={plan.planTitle}>
        📋 {plan.planTitle.length > 20 ? plan.planTitle.slice(0, 20) + '…' : plan.planTitle}
      </div>
      <div className="wp-plan-progress-row">
        <div className="wp-plan-track">
          <div
            className="wp-plan-fill"
            style={{ width: `${plan.percentComplete}%` }}
          />
        </div>
        <span className="wp-plan-percent">{plan.percentComplete}%</span>
      </div>
      <div className="wp-plan-steps">
        {plan.completedSteps}/{plan.totalSteps} 步骤
      </div>
      {plan.currentStep && (
        <div className="wp-plan-current" title={plan.currentStep}>
          → {plan.currentStep.length > 30 ? plan.currentStep.slice(0, 30) + '…' : plan.currentStep}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const planProgressWidget: IWallpaperWidgetDefinition = {
  id: 'plan-progress',
  name: '计划进度',
  priority: 20,
  zone: 'monitor',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return !!(ctx.monitoring?.plan?.hasActivePlan)
  },
  Component: PlanProgressPanel,
}
