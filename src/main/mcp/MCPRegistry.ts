import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../logger/Logger'
import { MCPServerManifest, MCPServerConfig } from './types'
import { WORKSPACE_ROOT } from '../config'

// ==================== 常量 ====================

/** Registry 文件路径：~/.mio/mcp/registry.json */
const REGISTRY_PATH = join(WORKSPACE_ROOT, 'mcp', 'registry.json')

/** 当前 schema 版本。升级时需要迁移逻辑 */
const SCHEMA_VERSION = 1

// ==================== 类型 ====================

interface RegistryFile {
  version: number
  servers: MCPServerManifest[]
}

/**
 * MCPRegistry — MCP Server 注册表。
 *
 * 职责 (ADR-014 M4)：
 * - 注册/注销/查询 MCP Server Manifest
 * - 持久化到 registry.json（atomic write + schema version）
 * - 启动时恢复所有已注册的 Server
 * - Manifest 校验（必填字段、dependencies 引用检查）
 *
 * 不负责：
 * - 进程生命周期（ProcessManager）
 * - MCP 协议握手（MCPControlPlane）
 * - 能力解析 / DAG 调度（Capability Layer）
 * - 自动安装
 * - 权限执行
 */
export class MCPRegistry {
  private manifests = new Map<string, MCPServerManifest>()
  private loaded = false

  // ==================== 外部接口 ====================

  /** 注册一个 MCP Server。幂等：相同 id 会覆盖 */
  register(manifest: MCPServerManifest): void {
    this.validateOrThrow(manifest)
    this.manifests.set(manifest.id, { ...manifest })
    log('INFO', 'mcp_registry.registered', { id: manifest.id, capabilities: manifest.capabilities.length })
  }

  /** 注销一个 MCP Server */
  unregister(id: string): boolean {
    const existed = this.manifests.has(id)
    this.manifests.delete(id)
    if (existed) log('INFO', 'mcp_registry.unregistered', { id })
    return existed
  }

  /** 获取单个 Manifest */
  get(id: string): MCPServerManifest | undefined {
    return this.manifests.get(id)
  }

  /** 列出所有已注册的 Manifest */
  list(): MCPServerManifest[] {
    return Array.from(this.manifests.values())
  }

  /** 检查 id 是否已注册 */
  has(id: string): boolean {
    return this.manifests.has(id)
  }

  /** 将 Manifest 转换为 MCPServerConfig 用于 MCPControlPlane.initialize() */
  toConfig(manifest: MCPServerManifest, overrides?: Partial<MCPServerConfig>): MCPServerConfig {
    return {
      name: manifest.id,
      transport: 'stdio',
      command: manifest.runtime.command,
      args: manifest.runtime.args,
      ...overrides,
    }
  }

  // ==================== 持久化 ====================

  /** 从 registry.json 加载 */
  load(): void {
    if (!existsSync(REGISTRY_PATH)) {
      this.loaded = true
      log('INFO', 'mcp_registry.load_skipped', { path: REGISTRY_PATH })
      return
    }

    try {
      const raw = readFileSync(REGISTRY_PATH, 'utf-8')
      const file: RegistryFile = JSON.parse(raw)

      if (typeof file.version !== 'number') {
        log('ERROR', 'mcp_registry.invalid_schema', { path: REGISTRY_PATH })
        return
      }

      if (file.version > SCHEMA_VERSION) {
        log('ERROR', 'mcp_registry.schema_too_new', { version: file.version, max: SCHEMA_VERSION })
        return
      }

      if (file.version < SCHEMA_VERSION) {
        this.migrate(file)
      }

      for (const manifest of file.servers) {
        try {
          this.validateOrThrow(manifest)
          this.manifests.set(manifest.id, manifest)
        } catch (err: any) {
          log('WARN', 'mcp_registry.skipping_invalid_entry', { id: manifest.id, error: err.message })
        }
      }

      this.loaded = true
      log('INFO', 'mcp_registry.loaded', { count: this.manifests.size, path: REGISTRY_PATH })
    } catch (err: any) {
      log('ERROR', 'mcp_registry.load_failed', { error: err.message, path: REGISTRY_PATH })
    }
  }

  /** 持久化到 registry.json（atomic write via temp file + rename） */
  save(): void {
    const file: RegistryFile = {
      version: SCHEMA_VERSION,
      servers: this.list(),
    }

    try {
      const dir = dirname(REGISTRY_PATH)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      // atomic write: write to temp file, then rename
      const tmpPath = REGISTRY_PATH + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8')
      renameSync(tmpPath, REGISTRY_PATH)

      log('INFO', 'mcp_registry.saved', { count: this.manifests.size })
    } catch (err: any) {
      log('ERROR', 'mcp_registry.save_failed', { error: err.message })
    }
  }

  // ==================== 校验 ====================

  private validateOrThrow(m: MCPServerManifest): void {
    if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id is required')
    if (!m.name || typeof m.name !== 'string') throw new Error('manifest.name is required for ' + m.id)
    if (!m.version || typeof m.version !== 'string') throw new Error('manifest.version is required for ' + m.id)
    if (!m.runtime || !m.runtime.command) throw new Error('manifest.runtime.command is required for ' + m.id)
    if (!Array.isArray(m.capabilities)) throw new Error('manifest.capabilities must be an array for ' + m.id)
    if (m.dependencies) {
      if (!Array.isArray(m.dependencies)) throw new Error('manifest.dependencies must be an array for ' + m.id)
      for (const dep of m.dependencies) {
        if (!dep.capability) throw new Error(`manifest.dependencies[].capability is required for ${m.id}`)
      }
    }
    if (!Array.isArray(m.permissions)) throw new Error('manifest.permissions must be an array for ' + m.id)
  }

  // ==================== 迁移 ====================

  private migrate(file: RegistryFile): void {
    // 当前 SCHEMA_VERSION = 1，暂无迁移逻辑
    // 扩展点：switch(file.version) { case 0: /* v0→v1 */ }
    file.version = SCHEMA_VERSION
  }
}

// ==================== Singleton ====================

export const mcpRegistry = new MCPRegistry()
