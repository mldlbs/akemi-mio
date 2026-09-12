/**
 * pipeline/PipelineEngine — 流水线执行引擎
 *
 * 职责：
 * 1.  加载 JSON 流水线定义 → 解析 Stage 列表
 * 2.  通过 DAG 拓扑排序确定执行顺序（dependsOn 隐式构建 DAG）
 * 3.  为每个 Stage 注入并执行对应的 StageExecutor
 * 4.  缓存可重放的中间结果（CacheManager）
 * 5.  收集所有 Stage 输出以供回放
 *
 * 设计原则：
 * - 无状态：PipelineEngine 不持有流水线运行状态，每次 run() 独立
 * - 可组合：多个流水线定义可共享同一引擎实例
 * - 容错：单个 Stage 失败不影响已完成的 Stage 输出
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { cacheManager, computeInputHash } from '@akemi-mio/intelligence/pipeline/CacheManager'
import type { PipelineDefinition, PipelineResult, StageDefinition, StageExecutor, StageOutput, StageExecutionContext } from '@akemi-mio/intelligence/pipeline/types'

export class PipelineEngine {
  /** 注册的 StageExecutor（stageType → instance） */
  private readonly registry = new Map<string, StageExecutor>()

  /** 当前流水线定义 */
  private definition: PipelineDefinition | null = null

  // ══════════════════════════════════════════
  //  Stage 注册
  // ══════════════════════════════════════════

  /**
   * 注册一个 StageExecutor。
   * 相同 stageType 的注册会覆盖之前的。
   */
  register(executor: StageExecutor): void {
    if (this.registry.has(executor.stageType)) {
      log('WARN', 'pipeline_executor_overwrite', { stageType: executor.stageType })
    }
    this.registry.set(executor.stageType, executor)
    log('INFO', 'pipeline_executor_registered', { stageType: executor.stageType })
  }

  /**
   * 批量注册多个 StageExecutor。
   */
  registerAll(executors: StageExecutor[]): void {
    for (const ex of executors) {
      this.register(ex)
    }
  }

  /** 获取已注册的所有 stageType */
  getRegisteredTypes(): string[] {
    return [...this.registry.keys()]
  }

  // ══════════════════════════════════════════
  //  流水线加载
  // ══════════════════════════════════════════

  /**
   * 加载流水线定义（从 JSON import 得到的对象）。
   *
   * 用法：import def from './definitions/my-pipeline.json'
   *       engine.load(def)
   *
   * @param def 流水线定义对象
   */
  load(def: PipelineDefinition): void

  /**
   * 加载流水线定义（从 JSON 对象）。
   */
  load(def: PipelineDefinition): PipelineDefinition {
    if (!def.pipelineId) throw new Error('Pipeline definition missing pipelineId')
    if (!def.stages || !Array.isArray(def.stages) || def.stages.length === 0) {
      throw new Error('Pipeline definition must have at least one stage')
    }

    // 校验 Stage ID 唯一性
    const ids = def.stages.map((s) => s.id)
    const uniqueIds = new Set(ids)
    if (ids.length !== uniqueIds.size) {
      throw new Error('Duplicate stage IDs in pipeline definition')
    }

    // 校验 dependsOn 引用合法性
    for (const stage of def.stages) {
      for (const dep of stage.dependsOn) {
        if (!uniqueIds.has(dep)) {
          throw new Error(`Stage "${stage.id}" depends on unknown stage "${dep}"`)
        }
      }
    }

    // 检测环形依赖
    this.validateDag(def.stages)

    this.definition = def
    log('INFO', 'pipeline_loaded', {
      pipelineId: def.pipelineId,
      stages: def.stages.length,
      version: def.version,
    })

    return def
  }

  /** 获取当前加载的流水线定义 */
  getDefinition(): PipelineDefinition | null {
    return this.definition
  }

  // ══════════════════════════════════════════
  //  流水线执行
  // ══════════════════════════════════════════

  /**
   * 执行整个流水线。
   *
   * @param pipelineInput 流水线的初始输入
   * @param options         执行选项
   * @returns             完整的 PipelineResult（含所有 stage 输出）
   */
  async run(
    pipelineInput: Record<string, unknown> = {},
    options?: {
      /** 强制跳过缓存（重新执行所有 stage） */
      noCache?: boolean
      /** 仅执行到指定 stage（含该 stage），用于调试 */
      upToStage?: string
      /** 自定义 traceId */
      traceId?: string
    },
  ): Promise<PipelineResult> {
    const def = this.definition
    if (!def) {
      return {
        pipelineId: 'unknown',
        success: false,
        stageOutputs: new Map(),
        finalOutput: null,
        totalDurationMs: 0,
        timestamp: Date.now(),
        error: 'No pipeline definition loaded. Call load() first.',
      }
    }

    const pipelineT0 = Date.now()
    const traceId = options?.traceId ?? `pipeline_${Date.now()}`
    const noCache = options?.noCache ?? false
    const upToStage = options?.upToStage

    // 拓扑排序
    const sortedStages = this.topologicalSort(def.stages)
    if (sortedStages.length === 0) {
      return {
        pipelineId: def.pipelineId,
        success: false,
        stageOutputs: new Map(),
        finalOutput: null,
        totalDurationMs: Date.now() - pipelineT0,
        timestamp: Date.now(),
        error: 'Cycle detected in pipeline stage dependencies',
      }
    }

    const stageOutputs = new Map<string, StageOutput>()
    const stageErrors: Record<string, string> = {}

    // 如果 noCache，清空缓存
    if (noCache) {
      cacheManager.invalidate()
    }

    // 遍历执行每个 stage
    for (const stageDef of sortedStages) {
      // 如果指定了 upToStage，到达后停止
      if (upToStage && stageDef.id === upToStage) {
        await this.executeSingleStage(stageDef, stageOutputs, pipelineInput, traceId, options)
          .then((output) => {
            stageOutputs.set(stageDef.id, output)
          })
          .catch((err) => {
            stageErrors[stageDef.id] = String(err)
          })
        break
      }

      try {
        const output = await this.executeSingleStage(stageDef, stageOutputs, pipelineInput, traceId, options)
        stageOutputs.set(stageDef.id, output)
      } catch (err) {
        const errMsg = String(err)
        stageErrors[stageDef.id] = errMsg
        log('ERROR', 'pipeline_stage_failed', {
          stageId: stageDef.id,
          error: errMsg,
          traceId,
        })
        // 继续执行其他 stage（不阻断）
      }
    }

    // 查找最后一个 stage 作为最终输出
    const lastStage = sortedStages[sortedStages.length - 1]
    const finalOutput = lastStage ? (stageOutputs.get(lastStage.id) ?? null) : null

    const totalDurationMs = Date.now() - pipelineT0
    const hasErrors = Object.keys(stageErrors).length > 0

    log('INFO', 'pipeline_completed', {
      pipelineId: def.pipelineId,
      stages: sortedStages.length,
      succeeded: stageOutputs.size,
      failed: Object.keys(stageErrors).length,
      durationMs: totalDurationMs,
      traceId,
    })

    return {
      pipelineId: def.pipelineId,
      success: !hasErrors,
      stageOutputs,
      finalOutput,
      totalDurationMs,
      timestamp: Date.now(),
      ...(hasErrors ? { error: `${Object.keys(stageErrors).length} stage(s) failed`, stageErrors } : {}),
    }
  }

  /**
   * 重放指定 stage 的输出（必须是已完成流水线中的 stage）。
   * 用于调试和中间结果检查。
   */
  replay(result: PipelineResult, stageId: string): StageOutput | null {
    return result.stageOutputs.get(stageId) ?? null
  }

  /** 重放所有 stage 的输出 */
  replayAll(result: PipelineResult): Map<string, StageOutput> {
    return new Map(result.stageOutputs)
  }

  /** 获取缓存统计 */
  getCacheStats() {
    return cacheManager.getStats()
  }

  /** 无效化缓存 */
  invalidateCache(stageId?: string): void {
    cacheManager.invalidate(stageId)
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 执行单个 Stage。
   * 先检查缓存 → 命中则直接返回缓存的输出。
   */
  private async executeSingleStage(
    stageDef: StageDefinition,
    completedOutputs: Map<string, StageOutput>,
    pipelineInput: Record<string, unknown>,
    traceId: string,
    options?: { noCache?: boolean },
  ): Promise<StageOutput> {
    const executor = this.registry.get(stageDef.stageType)
    if (!executor) {
      throw new Error(
        `No executor registered for stage type "${stageDef.stageType}". ` + `Registered types: [${this.getRegisteredTypes().join(', ')}]`,
      )
    }

    // 构建执行上下文
    const ctx: StageExecutionContext = {
      inputs: completedOutputs,
      pipelineInput,
      traceId,
    }

    // 计算输入哈希（用于缓存）
    const inputForHash: Record<string, unknown> = {
      config: stageDef.config,
      pipelineInput,
      // 包含依赖 stage 的输出摘要以供缓存区分
      ...Object.fromEntries(
        stageDef.dependsOn.map((depId) => {
          const dep = completedOutputs.get(depId)
          return [depId, dep?.data ?? null]
        }),
      ),
    }
    const inputHash = computeInputHash(inputForHash)

    // 检查缓存（除非 noCache）
    if (!options?.noCache) {
      const cached = cacheManager.get(stageDef.id, inputHash)
      if (cached) {
        log('DEBUG', 'pipeline_cache_hit_execute', {
          stageId: stageDef.id,
          traceId,
        })
        return cached
      }
    }

    // 执行 stage
    const output = await executor.execute(stageDef.config, ctx)

    // 缓存结果（仅成功时缓存）
    cacheManager.set(stageDef.id, inputHash, output)

    return output
  }

  /**
   * 拓扑排序 Stage 列表。
   * 使用 Kahn 算法实现 DAG 拓扑排序。
   * 若存在环形依赖，返回空数组。
   */
  private topologicalSort(stages: StageDefinition[]): StageDefinition[] {
    const idToStage = new Map(stages.map((s) => [s.id, s]))

    // 入度表
    const inDegree = new Map<string, number>()
    // 邻接表（依赖 → 被依赖者）
    const adjList = new Map<string, string[]>()

    for (const stage of stages) {
      inDegree.set(stage.id, 0)
      adjList.set(stage.id, [])
    }

    for (const stage of stages) {
      for (const dep of stage.dependsOn) {
        // dep → stage（dep 必须先执行，stage 后执行）
        const neighbors = adjList.get(dep)
        if (neighbors) {
          neighbors.push(stage.id)
        }
        inDegree.set(stage.id, (inDegree.get(stage.id) ?? 0) + 1)
      }
    }

    // Kahn 算法
    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    const sorted: StageDefinition[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      const stage = idToStage.get(id)
      if (stage) sorted.push(stage)

      for (const neighbor of adjList.get(id) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1
        inDegree.set(neighbor, newDeg)
        if (newDeg === 0) queue.push(neighbor)
      }
    }

    // 校验是否完全排序（有环则返回空）
    if (sorted.length !== stages.length) {
      const unsorted = stages.filter((s) => !sorted.find((st) => st.id === s.id))
      log('ERROR', 'pipeline_dag_cycle_detected', {
        unsorted: unsorted.map((s) => s.id).join(', '),
      })
      return []
    }

    return sorted
  }

  /**
   * 验证 DAG 无环。
   * 拓扑排序时已检测，此处仅做断言。
   */
  private validateDag(stages: StageDefinition[]): void {
    const sorted = this.topologicalSort(stages)
    if (sorted.length !== stages.length) {
      throw new Error('Circular dependency detected in pipeline stages')
    }
  }
}
