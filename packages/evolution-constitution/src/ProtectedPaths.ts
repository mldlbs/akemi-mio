import { minimatch } from 'minimatch'
import type { ProtectedPath } from './types'
import { normalizePath } from './types'

/**
 * 受保护路径匹配引擎。
 * 将 glob pattern 列表编译为匹配器，提供路径查询。
 */
export class ProtectedPaths {
  private immutableCache: ProtectedPath[] = []
  private mutableCache: ProtectedPath[] = []

  /** 加载受保护路径定义 */
  load(immutable: ProtectedPath[], mutable: ProtectedPath[]): void {
    this.immutableCache = [...immutable]
    this.mutableCache = [...mutable]
  }

  /** 是否有任何配置 */
  get hasRules(): boolean {
    return this.immutableCache.length > 0 || this.mutableCache.length > 0
  }

  /** 获取全部 immutable 路径定义 */
  getImmutable(): readonly ProtectedPath[] {
    return this.immutableCache
  }

  /** 获取全部 mutable 路径定义 */
  getMutable(): readonly ProtectedPath[] {
    return this.mutableCache
  }

  /**
   * 检查路径是否受保护（匹配任意 immutable pattern）。
   * 返回第一个匹配的 ProtectedPath，无匹配返回 null。
   */
  isProtected(absolutePath: string): ProtectedPath | null {
    const normalized = normalizePath(absolutePath)
    for (const pp of this.immutableCache) {
      if (minimatch(normalized, pp.pattern)) {
        return pp
      }
    }
    return null
  }

  /**
   * 检查路径是否属于 mutable 白名单。
   */
  isMutable(absolutePath: string): boolean {
    const normalized = normalizePath(absolutePath)
    return this.mutableCache.some((pp) => minimatch(normalized, pp.pattern))
  }

  /**
   * 检查写操作是否允许：
   * - 如果路径匹配 immutable pattern → 禁止
   * - 其余情况 → 允许
   */
  isWriteAllowed(absolutePath: string): boolean {
    return this.isProtected(absolutePath) === null
  }

  /** 重置所有规则 */
  clear(): void {
    this.immutableCache = []
    this.mutableCache = []
  }
}
