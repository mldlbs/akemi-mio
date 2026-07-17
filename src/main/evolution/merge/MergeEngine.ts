/**
 * MergeEngine — 自进化合并引擎主编排器
 *
 * 协调整个合并流程：
 * 1. 接收 MergeEngineCollector 触发的分析请求
 * 2. 调用 MergeAnalyzer 扫描代码
 * 3. 调用 MergePlanGenerator 生成计划
 * 4. 调用 MergePatchExecutor 执行补丁
 * 5. 跟踪合并状态和进度
 *
 * 也负责实现 FixExecutor 接口，以便通过 PipelineOrchestrator 消费问题。
 */

import { log } from '../../logger/Logger'
import { MergeAnalyzer } from './MergeAnalyzer'
import { MergePlanGenerator } from './MergePlanGenerator'
import { MergePatchExecutor } from './MergePatchExecutor'
import { MergeSecurityScanner } from './MergeSecurityScanner'
import type {
  MergeEngineStatus,
  MergeGap,
  MergePlan,
  MergePatch,
  MergeScanResult,
} from './types'
import type { FixExecutor, FixResult, AssignedProblem, ProblemSource } from '../automation/types'

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

/** 执行超时 */
const EXEC_TIMEOUT_MS = 300_000

/** 两次执行最小间隔 */
const MIN_INTERVAL_MS = 60_000

/** 支持的问题来源 */
const SUPPORTED_SOURCES: ProblemSource[] = ['tool']

// ═══════════════════════════════════════════
// MergeEngine
// ═══════════════════════════════════════════

export class MergeEngine implements FixExecutor {
  readonly name = 'merge-engine'
  readonly supportedSources: ProblemSource[] = SUPPORTED_SOURCES
  readonly timeoutMs = EXEC_TIMEOUT_MS

  private analyzer: MergeAnalyzer
  private planGenerator: MergePlanGenerator
  private patchExecutor: MergePatchExecutor
  private securityScanner: MergeSecurityScanner

  private _lastRunAt = 0
  private _busy = false
  private _totalGapsFixed = 0
  private _totalGapsFailed = 0
  private _currentStatus: MergeEngineStatus

  constructor() {
    this.analyzer = new MergeAnalyzer()
    this.planGenerator = new MergePlanGenerator()
    this.patchExecutor = new MergePatchExecutor()
    this.securityScanner = new MergeSecurityScanner()

    this._currentStatus = this.createEmptyStatus()
  }

  // ═════════════════════════════════════════
  //  FixExecutor 接口实现
  // ═════════════════════════════════════════

  isAvailable(): boolean {
    if (this._busy) return false
    if (Date.now() - this._lastRunAt < MIN_INTERVAL_MS) return false
    return true
  }

  /**
   * FixExecutor.execute — 消费单个合并问题。
   * PipelineOrchestrator 调用此方法处理 ProblemQueue 中的合并缺口。
   */
  async execute(problem: AssignedProblem): Promise<FixResult> {
    this._busy = true
    this._lastRunAt = Date.now()
    const startedAt = Date.now()

    try {
      const metadata = problem.context.metadata
      const gapType = metadata?.gap_type || 'unknown'
      const sourceModule = metadata?.source_module || 'unknown'

      log('INFO', 'merge_execute_start', {
        problemId: problem.id,
        gapType,
        file: problem.file,
      })

      // 1. 运行分析，获取最新扫描结果
      let scanResult = this.analyzer.getLastScanResult()
      if (!scanResult) {
        scanResult = await this.analyzer.scan()
      }

      // 2. 找到匹配的缺口
      const gapId = metadata?.gap_id
      const matchedGap = gapId
        ? scanResult.gaps.find(g => g.id === gapId)
        : scanResult.gaps.find(g => g.targetFile === problem.file && g.type === gapType)

      if (!matchedGap) {
        // 缺口已不存在（已被修复）
        this.planGenerator.markGapAttempted(gapId || problem.id)
        return {
          problemId: problem.id,
          success: true,
          summary: `缺口已不存在，跳过 (${problem.file})`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 3. 创建包含此缺口的计划
      const plan: MergePlan = {
        id: `merge_exec_${problem.id}`,
        gaps: [matchedGap],
        createdAt: Date.now(),
        status: 'in_progress',
        summary: `执行 ${matchedGap.description}`,
      }

      // 4. 执行补丁
      const patches = await this.patchExecutor.executePlan(plan)

      // 5. 分析结果
      const successPatch = patches.find(p => p.status === 'verified' || p.status === 'applied')
      const failedPatch = patches.find(p => p.status === 'rollback' || p.status === 'failed')

      if (successPatch) {
        this._totalGapsFixed++
        this.markGapDone(matchedGap.id, problem.id)

        return {
          problemId: problem.id,
          success: true,
          summary: `✅ ${matchedGap.description} — ${successPatch.status === 'verified' ? '已验证并提交' : '已应用'}`,
          durationMs: Date.now() - startedAt,
          output: successPatch.patchContent.slice(0, 500),
        }
      }

      if (failedPatch) {
        this._totalGapsFailed++
        this.planGenerator.markGapAttempted(matchedGap.id)

        return {
          problemId: problem.id,
          success: false,
          summary: `❌ ${matchedGap.description} — 补丁应用失败，已回滚`,
          durationMs: Date.now() - startedAt,
          error: 'merge_patch_failed',
        }
      }

      // 无变更需要
      this.markGapDone(matchedGap.id, problem.id)
      return {
        problemId: problem.id,
        success: true,
        summary: `⏭ ${matchedGap.description} — 无需变更（已集成）`,
        durationMs: Date.now() - startedAt,
      }
    } catch (err: any) {
      log('ERROR', 'merge_execute_error', { problemId: problem.id, error: err.message })
      return {
        problemId: problem.id,
        success: false,
        summary: `执行异常: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: err.message,
      }
    } finally {
      this._busy = false
    }
  }

  // ═════════════════════════════════════════
  //  全量合并流程（用于手动触发）
  // ═════════════════════════════════════════

  /**
   * 运行一次完整的合并检查周期。
   * 包括扫描 → 计划 → 执行全流程。
   */
  async runFullCycle(): Promise<{
    scanResult: MergeScanResult | null
    plan: MergePlan | null
    patches: MergePatch[]
  }> {
    log('INFO', 'merge_cycle_start')

    this._currentStatus.isRunning = true
    this._currentStatus.lastScanAt = Date.now()

    try {
      // 1. 扫描分析
      const scanResult = await this.analyzer.scan()
      this._currentStatus.totalGapsFound = scanResult.gaps.length

      if (scanResult.gaps.length === 0) {
        log('INFO', 'merge_cycle_no_gaps', {
          integrationScore: scanResult.integrationScore,
        })
        this._currentStatus.isRunning = false
        return { scanResult, plan: null, patches: [] }
      }

      // 2. 计划生成
      const plan = this.planGenerator.generatePlan(scanResult)
      this._currentStatus.currentPlan = plan

      if (plan.status === 'no_gaps') {
        this._currentStatus.isRunning = false
        return { scanResult, plan, patches: [] }
      }

      // 3. 补丁执行
      const patches = await this.patchExecutor.executePlan(plan)

      // 4. 更新状态
      const successCount = patches.filter(p => p.status === 'verified' || p.status === 'applied').length
      const failCount = patches.filter(p => p.status === 'rollback' || p.status === 'failed').length
      this._totalGapsFixed += successCount
      this._totalGapsFailed += failCount
      this._currentStatus.totalGapsFixed = this._totalGapsFixed
      this._currentStatus.totalGapsFailed = this._totalGapsFailed

      plan.status = successCount > 0 && failCount === 0 ? 'completed' : failCount > 0 ? 'failed' : 'completed'
      this._currentStatus.currentPlan = plan
      this._currentStatus.lastMergeAt = Date.now()

      log('INFO', 'merge_cycle_complete', {
        gapsFound: scanResult.gaps.length,
        patchesApplied: successCount,
        patchesFailed: failCount,
        integrationScore: scanResult.integrationScore,
      })

      return { scanResult, plan, patches }
    } catch (err: any) {
      log('ERROR', 'merge_cycle_error', { error: err.message })

      if (this._currentStatus.currentPlan) {
        this._currentStatus.currentPlan.status = 'failed'
      }

      return {
        scanResult: null,
        plan: this.planGenerator.generateFallbackPlan(err.message),
        patches: [],
      }
    } finally {
      this._currentStatus.isRunning = false
    }
  }

  // ═════════════════════════════════════════
  //  状态查询
  // ═════════════════════════════════════════

  /** 获取引擎状态 */
  getStatus(): MergeEngineStatus {
    return { ...this._currentStatus }
  }

  /** 获取分析器 */
  getAnalyzer(): MergeAnalyzer {
    return this.analyzer
  }

  /** 获取计划生成器 */
  getPlanGenerator(): MergePlanGenerator {
    return this.planGenerator
  }

  /** 获取补丁执行器 */
  getPatchExecutor(): MergePatchExecutor {
    return this.patchExecutor
  }

  /** 获取安全扫描器 */
  getSecurityScanner(): MergeSecurityScanner {
    return this.securityScanner
  }

  /** 清除分析缓存 */
  clearCache(): void {
    this.analyzer.clearCache()
    this.planGenerator.clearCache()
  }

  // ═════════════════════════════════════════
  //  内部方法
  // ═════════════════════════════════════════

  private markGapDone(gapId: string, problemId: string): void {
    this.planGenerator.markGapAttempted(gapId)
  }

  private createEmptyStatus(): MergeEngineStatus {
    return {
      lastScanAt: 0,
      lastMergeAt: 0,
      totalGapsFound: 0,
      totalGapsFixed: 0,
      totalGapsFailed: 0,
      currentPlan: null,
      isRunning: false,
    }
  }
}
