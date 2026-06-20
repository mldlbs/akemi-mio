/**
 * SystemStabilityScore — Agent OS 系统稳定性评分。
 *
 * 六因子乘法模型：
 *   score = memoryHealth × taskFlowEfficiency × schedulerBalance × evolutionRiskControl × errorRateInverse × guardrailHealth
 *
 * score ∈ [0, 100]，起始值 100，健康阈值 >= 70，临界阈值 < 40。
 */
export interface StabilityFactors {
  memoryHealth: number
  taskFlowEfficiency: number
  schedulerBalance: number
  evolutionRiskControl: number
  errorRateInverse: number
  guardrailHealth: number
}

export type StabilityStatus = 'healthy' | 'degraded' | 'critical'

interface HistoryPoint {
  score: number
  timestamp: number
}

export class SystemStabilityScore {
  private score = 100
  private history: HistoryPoint[] = []
  private readonly maxHistory = 60

  /** 计算稳定性分数并平滑更新 */
  compute(factors: StabilityFactors): number {
    const raw =
      factors.memoryHealth *
      factors.taskFlowEfficiency *
      factors.schedulerBalance *
      factors.evolutionRiskControl *
      factors.errorRateInverse *
      factors.guardrailHealth

    const computed = Math.round(Math.min(100, raw * 100))

    // 指数平滑，避免剧烈跳变
    if (this.history.length === 0) {
      this.score = computed
    } else {
      this.score = Math.round(this.score * 0.7 + computed * 0.3)
    }

    this.history.push({ score: this.score, timestamp: Date.now() })
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }

    return this.score
  }

  getScore(): number {
    return this.score
  }

  /** 比较最近10个点 vs 前10个点的均值 */
  getTrend(): 'improving' | 'declining' | 'stable' {
    if (this.history.length < 20) return 'stable'

    const recent = this.history.slice(-10).reduce((s, p) => s + p.score, 0) / 10
    const previous = this.history.slice(-20, -10).reduce((s, p) => s + p.score, 0) / 10

    const diff = recent - previous
    if (diff > 2) return 'improving'
    if (diff < -2) return 'declining'
    return 'stable'
  }

  getHistory(): { score: number; timestamp: number }[] {
    return [...this.history]
  }

  getStatus(): StabilityStatus {
    if (this.score >= 70) return 'healthy'
    if (this.score >= 40) return 'degraded'
    return 'critical'
  }

  isHealthy(): boolean {
    return this.score >= 70
  }

  isCritical(): boolean {
    return this.score < 40
  }

  /** 根据当前稳定性给出操作建议 */
  /** 根据当前稳定性分数返回推荐预算调节参数 */
  autoTuneConfig(): { reduceBy?: number; restoreBy?: number; action: 'restore' | 'reduce' | 'none' } {
    const status = this.getStatus()
    if (status === 'healthy' && this.score >= 90) {
      return { action: 'restore', restoreBy: 10 }
    }
    if (status === 'critical') {
      return { action: 'reduce', reduceBy: 0.5 }
    }
    if (status === 'degraded') {
      return { action: 'reduce', reduceBy: 0.8 }
    }
    return { action: 'none' }
  }

  getRecommendations(): string[] {
    const recommendations: string[] = []
    const status = this.getStatus()

    if (status === 'healthy') {
      if (this.score >= 95) {
        recommendations.push('系统运行极佳，可考虑启用更多进化实验')
      } else {
        recommendations.push('系统稳定，继续常规操作')
      }
    }

    if (status === 'degraded') {
      if (this.score < 60) {
        recommendations.push('减少后台任务并发数')
        recommendations.push('检查内存使用情况')
      }
      recommendations.push('暂停高风险进化提案')
      recommendations.push('监控系统指标变化趋势')
    }

    if (status === 'critical') {
      recommendations.push('立即停止所有非关键任务')
      recommendations.push('触发系统降级模式')
      recommendations.push('考虑回滚最近的进化变更')
      recommendations.push('检查资源预算是否耗尽')
      recommendations.push('检查 GoalGuardrail 熔断状态 — 可能存在 LLM 对抗性绕过行为')
    }

    return recommendations
  }
}
