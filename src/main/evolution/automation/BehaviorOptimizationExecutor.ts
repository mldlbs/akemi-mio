/**
 * BehaviorOptimizationExecutor — 行为驱动优化执行器
 *
 * 消费 BehaviorCollector 生成的 Problem（source='behavior'），
 * 根据优化类型生成代码变更计划并记录影响。
 *
 * ── 优化类型及对应的执行策略 ──
 * - preload_module:   生成预加载配置（配置文件 patch）
 * - optimize_response: 生成响应延迟优化建议（输出文件）
 * - add_cache:        生成缓存注入配置
 * - improve_error:    生成错误处理增强 patch
 * - merge_tools:      生成工具合并建议
 * - increase_priority: 生成优先级调整配置
 *
 * ── 执行模式 ──
 * 当前为"建议生成"模式：输出优化建议文件到进化工作区，
 * 不直接修改代码（高风险操作需人肉确认）。
 * 未来可扩展为"自动修补"模式。
 */

import { log } from '../../logger/Logger'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { WORKSPACE } from '../../config'

/** 行为优化输出目录 */
const OPTIMIZATIONS_DIR = join(WORKSPACE.evolution, 'behavior_optimizations')

export class BehaviorOptimizationExecutor implements FixExecutor {
  readonly name = 'behavior-optimization-executor'
  readonly timeoutMs = 30_000
  readonly supportedSources = ['behavior']

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()

    try {
      const optimizationType = problem.context.metadata?.optimizationType || 'unknown'
      const target = problem.context.metadata?.target || 'unknown'
      const expectedBenefit = problem.context.metadata?.expectedBenefit || ''
      const risk = problem.context.metadata?.risk || ''

      log('INFO', 'behavior_opt_exec_start', {
        problemId: problem.id,
        type: optimizationType,
        target,
      })

      // 确保输出目录存在
      if (!existsSync(OPTIMIZATIONS_DIR)) {
        mkdirSync(OPTIMIZATIONS_DIR, { recursive: true })
      }

      // 根据优化类型生成对应的优化计划文件
      const planFilePath = join(OPTIMIZATIONS_DIR, `${problem.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.json`)

      const plan = this.buildOptimizationPlan(problem, optimizationType, target)

      writeFileSync(planFilePath, JSON.stringify(plan, null, 2), 'utf-8')

      log('INFO', 'behavior_opt_exec_done', {
        planFile: planFilePath,
        durationMs: Date.now() - startTime,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: `✅ 生成行为优化计划: [${optimizationType}] ${problem.title}`,
        durationMs: Date.now() - startTime,
        output: `优化计划已输出到: ${planFilePath}\n预期收益: ${expectedBenefit}\n风险: ${risk}`,
      }
    } catch (err: any) {
      log('ERROR', 'behavior_opt_exec_error', {
        problemId: problem.id,
        error: err.message,
      })

      return {
        problemId: problem.id,
        success: false,
        summary: `行为优化执行失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  /**
   * 构建优化计划对象。
   * 包含优化类型、目标、实现步骤、预期收益和影响评估。
   */
  private buildOptimizationPlan(
    problem: AssignedProblem,
    optimizationType: string,
    target: string,
  ): BehaviorOptimizationPlan {
    const plan: BehaviorOptimizationPlan = {
      planId: problem.id,
      type: optimizationType,
      target,
      title: problem.title,
      description: problem.description,
      priority: parseInt(problem.context.metadata?.priority || '50'),
      expectedBenefit: problem.context.metadata?.expectedBenefit || '',
      risk: problem.context.metadata?.risk || '',
      behaviorContext: this.extractBehaviorContext(problem),
      implementationSteps: this.generateImplementationSteps(optimizationType, target, problem),
      createdAt: Date.now(),
      status: 'proposed',
    }

    return plan
  }

  /**
   * 从 Problem 的 context.metadata 中提取行为上下文。
   */
  private extractBehaviorContext(problem: AssignedProblem): BehaviorContext {
    const metadata = problem.context.metadata || {}

    let frequentSequences: Array<{ tools: string[]; frequency: number }> = []
    let pausePoints: Array<{ tool: string; avgWaitMs: number }> = []

    try {
      if (metadata.frequentSequences) {
        frequentSequences = JSON.parse(metadata.frequentSequences)
      }
    } catch { /* ignore parse errors */ }

    try {
      if (metadata.pausePoints) {
        pausePoints = JSON.parse(metadata.pausePoints)
      }
    } catch { /* ignore parse errors */ }

    return {
      totalToolCalls: parseInt(metadata.totalToolCalls || '0'),
      frequentSequences,
      pausePoints,
    }
  }

  /**
   * 根据优化类型生成具体的实现步骤。
   * 每个步骤对应一个代码变更操作。
   */
  private generateImplementationSteps(
    optimizationType: string,
    target: string,
    problem: AssignedProblem,
  ): ImplementationStep[] {
    const baseSteps: ImplementationStep[] = [
      {
        order: 1,
        action: 'review',
        description: `审查 ${target} 的当前实现代码`,
        targetFile: this.resolveTargetFile(target),
        estimatedEffort: '10min',
      },
    ]

    switch (optimizationType) {
      case 'preload_module': {
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `在 ${target} 的执行入口添加后续模块的预加载逻辑`,
            detail: `当 ${target} 被调用时，异步预加载后续高频工具所需的数据和上下文`,
            estimatedEffort: '20min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证预加载不引入额外的延迟或内存泄漏',
            estimatedEffort: '10min',
          },
        )
        break
      }

      case 'optimize_response': {
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `优化 ${target} 的响应输出逻辑`,
            detail: '添加流式输出、减少同步阻塞、增加进度反馈',
            estimatedEffort: '30min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证响应时间减少和输出格式兼容性',
            estimatedEffort: '15min',
          },
        )
        break
      }

      case 'add_cache': {
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `为 ${target} 添加 LRU 缓存层`,
            detail: '使用 Map 实现 LRU 缓存，设置合理的 TTL（建议 5-30 秒）',
            estimatedEffort: '20min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证缓存的命中率和数据一致性',
            estimatedEffort: '10min',
          },
        )
        break
      }

      case 'improve_error': {
        baseSteps.push(
          {
            order: 2,
            action: 'modify',
            description: `增强 ${target} 的错误处理逻辑`,
            detail: '添加重试机制、更友好的错误提示、优雅降级策略',
            estimatedEffort: '25min',
          },
          {
            order: 3,
            action: 'verify',
            description: '验证错误场景下的行为符合预期',
            estimatedEffort: '15min',
          },
        )
        break
      }

      default: {
        baseSteps.push({
          order: 2,
          action: 'analyze',
          description: `分析 ${target} 的优化可行性`,
          estimatedEffort: '15min',
        })
      }
    }

    return baseSteps
  }

  /**
   * 根据目标工具名推断对应的代码文件路径。
   * 如果无法匹配已知模块，返回通用路径。
   */
  private resolveTargetFile(target: string): string {
    const knownModules: Record<string, string> = {
      // Agent 工具
      grep: 'src/main/agent/tools/grep.ts',
      read_file: 'src/main/agent/tools/readFile.ts',
      write_file: 'src/main/agent/tools/writeFile.ts',
      edit_file: 'src/main/agent/tools/editFile.ts',
      // 核心模块
      analyze_codebase: 'src/main/agent/tools/analyzeCodebase.ts',
      remember_fact: 'src/main/agent/tools/rememberFact.ts',
      create_dev_plan: 'src/main/agent/tools/createDevPlan.ts',
      // 用户行为
      userBehaviorAnalyzer: 'src/main/agent/UserBehaviorAnalyzer.ts',
      // 进化
      SelfEvolutionService: 'src/main/evolution/SelfEvolutionService.ts',
      // 工具执行
      'ChatExecutor': 'src/main/agent/ChatExecutor.ts',
    }

    // 尝试精确匹配
    if (knownModules[target]) return knownModules[target]

    // 尝试部分匹配
    for (const [key, path] of Object.entries(knownModules)) {
      if (target.includes(key) || key.includes(target)) {
        return path
      }
    }

    return `src/main/unknown/${target}.ts`
  }
}

// =============================================================================
// 类型定义
// =============================================================================

export interface BehaviorOptimizationPlan {
  /** 计划 ID */
  planId: string
  /** 优化类型 */
  type: 'preload_module' | 'optimize_response' | 'add_cache' | 'improve_error' | 'merge_tools' | 'increase_priority' | string
  /** 优化目标 */
  target: string
  /** 标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 优先级 0-100 */
  priority: number
  /** 预期收益 */
  expectedBenefit: string
  /** 风险说明 */
  risk: string
  /** 行为上下文 */
  behaviorContext: BehaviorContext
  /** 实现步骤 */
  implementationSteps: ImplementationStep[]
  /** 创建时间 */
  createdAt: number
  /** 计划状态 */
  status: 'proposed' | 'approved' | 'implemented' | 'rejected' | 'rolled_back'
}

export interface BehaviorContext {
  totalToolCalls: number
  frequentSequences: Array<{ tools: string[]; frequency: number }>
  pausePoints: Array<{ tool: string; avgWaitMs: number }>
}

export interface ImplementationStep {
  order: number
  action: 'review' | 'modify' | 'verify' | 'analyze'
  description: string
  targetFile?: string
  detail?: string
  estimatedEffort: string
}
