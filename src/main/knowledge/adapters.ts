/**
 * 适配器 — 将现有 Memory / Agent 组件包装为 IKnowledgeSource
 *
 * 策略模式：每个适配器是一个 IKnowledgeSource 的具体实现，
 * 在 UnifiedKnowledgeQuery 中注册后可按统一接口查询。
 *
 * 当前适配的组件：
 * - MemoryService（通过 IMemoryPlugin 包装）
 * - ProceduralMemory（Agent 流程记忆）
 * - ReflectLoop（Agent 反思记录）
 * - FailureAnalyzer（Agent 失败模式）
 * - EngineeringMemory（工程经验）
 */

import { log } from '../logger/Logger'
import type { IKnowledgeSource, IMutableKnowledgeSource, KnowledgeItem, QueryOptions, SaveInput } from './IKnowledgeSource'
import type { ProceduralMemory } from '../agent/ProceduralMemory'
import type { ReflectLoop } from '../agent/ReflectLoop'
import type { FailureAnalyzer } from '../agent/FailureAnalyzer'
import type { IMemoryPlugin, MemoryRetrievalResult } from '../memory/IMemoryPlugin'

// ─── 工具函数 ───

function toKnowledgeItem(r: MemoryRetrievalResult, source: string): KnowledgeItem {
  return {
    id: `${source}_${r.timestamp ?? Date.now()}`,
    content: r.content,
    score: r.score,
    source,
    metadata: r.metadata,
    timestamp: r.timestamp ?? Date.now(),
  }
}

// ════════════════════════════════════════
//  1. MemoryPluginAdapter — 包装 IMemoryPlugin
// ════════════════════════════════════════

/**
 * 将 IMemoryPlugin 适配为 IKnowledgeSource。
 * 覆盖所有的 Memory 后端（Vector、KG、Summary、Engineering 等）。
 */
export class MemoryPluginAdapter implements IKnowledgeSource {
  readonly name: string

  constructor(private plugin: IMemoryPlugin) {
    this.name = plugin.name
  }

  async query(query: string, options?: QueryOptions): Promise<KnowledgeItem[]> {
    const topK = options?.topK ?? 5
    const results = await this.plugin.retrieve(query, topK)
    if (options?.minScore !== undefined) {
      return results
        .filter((r) => r.score >= options.minScore!)
        .map((r) => toKnowledgeItem(r, this.name))
    }
    return results.map((r) => toKnowledgeItem(r, this.name))
  }

  getContext(query?: string): Promise<string> | string {
    if (this.plugin.getContext) {
      return this.plugin.getContext(query)
    }
    return ''
  }

  dispose(): void | Promise<void> {
    return this.plugin.dispose?.()
  }
}

// ════════════════════════════════════════
//  2. ProceduralMemoryAdapter
// ════════════════════════════════════════

/**
 * 将 ProceduralMemory 适配为 IMutableKnowledgeSource。
 * Agent 的流程记忆：保存/检索可复用的操作序列。
 */
export class ProceduralMemoryAdapter implements IMutableKnowledgeSource {
  readonly name = 'procedural'

  constructor(private memory: ProceduralMemory) {}

  async query(query: string, options?: QueryOptions): Promise<KnowledgeItem[]> {
    const topK = options?.topK ?? 3

    // 语义嵌入检索
    const byEmbedding = this.memory.findByEmbedding(query, topK)
    // 关键词检索（语义检索的补充）
    const keywords = query.split(/\s+/).filter((w) => w.length > 1)
    const byKeywords = keywords.length > 0 ? this.memory.findByKeywords(keywords, topK) : []

    // 合并去重（按 name）
    const seenNames = new Set<string>()
    const merged: KnowledgeItem[] = []
    for (const p of [...byEmbedding, ...byKeywords]) {
      if (seenNames.has(p.name)) continue
      seenNames.add(p.name)
      if (options?.minScore !== undefined) {
        const score = byEmbedding.includes(p) ? 0.8 : 0.6
        if (score < options.minScore) continue
      }
      merged.push({
        id: p.id,
        content: `【流程】${p.name}: ${p.description}\n步骤: ${p.steps.map((s, i) => `${i + 1}.${s}`).join(' → ')}`,
        score: byEmbedding.includes(p) ? 0.8 : 0.6,
        source: this.name,
        metadata: {
          name: p.name,
          steps: p.steps,
          triggerKeywords: p.triggerKeywords,
          successCount: p.successCount,
          failCount: p.failCount,
        },
        timestamp: p.updatedAt,
      })
    }

    return merged.slice(0, topK)
  }

  getContext(query?: string): Promise<string> | string {
    const keywords = query?.split(/\s+/).filter((w) => w.length > 1)
    return this.memory.getFormattedContext(keywords)
  }

  async save(input: SaveInput): Promise<string> {
    const name = input.metadata?.name as string || input.content.slice(0, 40)
    const steps = input.metadata?.steps as string[] || [input.content]
    const triggerKeywords = input.tags || []
    const procedure = this.memory.save({
      name,
      description: input.content,
      steps,
      triggerKeywords,
    })
    return procedure.id
  }

  async delete(id: string): Promise<boolean> {
    // ProceduralMemory 没有单独删除方法，记录日志
    log('WARN', 'procedural_delete_not_implemented', { id })
    return false
  }

  listAll(): Promise<KnowledgeItem[]> {
    return Promise.resolve(this.memory.listAll().map((p) => ({
      id: p.id,
      content: `${p.name}: ${p.description}`,
      score: Math.min(0.9, 0.3 + (p.successCount / Math.max(p.successCount + p.failCount, 1)) * 0.6),
      source: this.name,
      metadata: {
        name: p.name,
        steps: p.steps,
        triggerKeywords: p.triggerKeywords,
        successCount: p.successCount,
        failCount: p.failCount,
      },
      timestamp: p.updatedAt,
    })))
  }
}

// ════════════════════════════════════════
//  3. ReflectLoopAdapter
// ════════════════════════════════════════

/**
 * 将 ReflectLoop 适配为 IKnowledgeSource。
 * Agent 的反思上下文（仅读）。
 */
export class ReflectLoopAdapter implements IKnowledgeSource {
  readonly name = 'reflection'

  constructor(private loop: ReflectLoop) {}

  async query(_query: string, options?: QueryOptions): Promise<KnowledgeItem[]> {
    // ReflectLoop 不支持查询，返回空
    return []
  }

  getContext(): Promise<string> | string {
    return this.loop.getFormattedContext()
  }

  dispose(): void {
    // ReflectLoop 无清理需求
  }
}

// ════════════════════════════════════════
//  4. FailureAnalyzerAdapter
// ════════════════════════════════════════

/**
 * 将 FailureAnalyzer 适配为 IKnowledgeSource。
 * Agent 的失败模式聚合（仅读）。
 */
export class FailureAnalyzerAdapter implements IKnowledgeSource {
  readonly name = 'failure_patterns'

  constructor(private analyzer: FailureAnalyzer) {}

  async query(query: string, options?: QueryOptions): Promise<KnowledgeItem[]> {
    const topK = options?.topK ?? 3
    const hot = this.analyzer.getHotPatterns(topK)

    // 按查询文本相关性过滤
    const q = query.toLowerCase()
    const results: KnowledgeItem[] = hot
      .filter((p) => {
        const allNames = Array.from(p.names)
        return (
          q.length === 0 ||
          allNames.some((n) => n.toLowerCase().includes(q)) ||
          p.errors.some((e) => e.toLowerCase().includes(q))
        )
      })
      .map((p, i) => ({
        id: `fp_${p.fingerprint}_${i}`,
        content: `[${p.count}次] ${Array.from(p.names).join(', ')}: ${p.errors[0]?.slice(0, 120) || '未知错误'}`,
        score: Math.min(0.9, 0.2 + p.count * 0.1),
        source: this.name,
        metadata: {
          count: p.count,
          names: Array.from(p.names),
          errors: p.errors,
          firstSeen: p.firstSeen,
          lastSeen: p.lastSeen,
        },
        timestamp: p.lastSeen,
      }))

    return results
  }

  getContext(): Promise<string> | string {
    return this.analyzer.getFormattedContext()
  }
}

// ════════════════════════════════════════
//  5. CompositeAdapter — 适配 getFormattedContext 类组件
// ════════════════════════════════════════

/**
 * 通用适配器：包装仅有 getFormattedContext() 方法的对象。
 * 适用于只提供上下文而不支持检索的组件。
 */
export class ContextOnlyAdapter implements IKnowledgeSource {
  readonly name: string

  constructor(
    name: string,
    private contextProvider: {
      getFormattedContext: () => string
    },
  ) {
    this.name = name
  }

  async query(): Promise<KnowledgeItem[]> {
    // 不支持语义查询
    return []
  }

  getContext(): Promise<string> | string {
    return this.contextProvider.getFormattedContext()
  }
}

// ════════════════════════════════════════
//  Factory helpers
// ════════════════════════════════════════

/**
 * 便捷工厂：从 IMemoryPlugin 创建 MemoryPluginAdapter。
 */
export function adaptMemoryPlugin(plugin: IMemoryPlugin): MemoryPluginAdapter {
  return new MemoryPluginAdapter(plugin)
}

/**
 * 便捷工厂：从 ProceduralMemory 创建适配器。
 */
export function adaptProceduralMemory(memory: ProceduralMemory): ProceduralMemoryAdapter {
  return new ProceduralMemoryAdapter(memory)
}

/**
 * 便捷工厂：从 ReflectLoop 创建适配器。
 */
export function adaptReflectLoop(loop: ReflectLoop): ReflectLoopAdapter {
  return new ReflectLoopAdapter(loop)
}

/**
 * 便捷工厂：从 FailureAnalyzer 创建适配器。
 */
export function adaptFailureAnalyzer(analyzer: FailureAnalyzer): FailureAnalyzerAdapter {
  return new FailureAnalyzerAdapter(analyzer)
}
