import { log } from '@akemi-mio/core/logger/Logger'
import { type ToolSchema } from './types'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { AuditTrail } from './AuditTrail'
import { pluginHealthGuard, type ConflictResolution } from './PluginHealthGuard'

/**
 * 已知权限类型
 * 'filesystem:read'  — 读取文件系统
 * 'filesystem:write' — 写入文件系统
 * 'network:http'     — 发起 HTTP 请求
 * 'shell:exec'       — 执行 shell 命令
 * 'system:manage'    — 管理系统（插件、配置等）
 * 'storage:read'     — 读取插件存储
 * 'storage:write'    — 写入插件存储
 */
export type Permission =
  | 'filesystem:read'
  | 'filesystem:write'
  | `filesystem:read:${string}`
  | `filesystem:write:${string}`
  | 'network:http'
  | 'shell:exec'
  | 'system:manage'
  | 'storage:read'
  | 'storage:write'

/** 内置插件权限映射（短名称 → 标准权限） */
const BUILTIN_PERMISSION_MAP: Record<string, Permission[]> = {
  file: ['filesystem:read', 'filesystem:write'],
  system: ['shell:exec', 'system:manage'],
  network: ['network:http'],
  storage: ['storage:read', 'storage:write'],
}

/** 将 manifest.permissions 中的短名称展开为标准权限列表 */
export function expandPermissions(shortNames: string[]): Permission[] {
  const result: Permission[] = []
  for (const name of shortNames) {
    if (name in BUILTIN_PERMISSION_MAP) {
      result.push(...BUILTIN_PERMISSION_MAP[name])
    } else if (
      name.startsWith('filesystem:') ||
      name.startsWith('network:') ||
      name.startsWith('shell:') ||
      name.startsWith('system:') ||
      name.startsWith('storage:')
    ) {
      result.push(name as Permission)
    }
  }
  return [...new Set(result)]
}

export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string }>
  required: string[]
  handler: (args: Record<string, any>) => string | Promise<string>
  pluginName: string
  /** 工具运行所需权限（从插件 manifest.permissions 派生） */
  requiredPermissions?: Permission[]
}

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>()
  /** 默认权限集 — 不设置时拥有全部权限（完全兼容现有行为） */
  private defaultPermissions: Permission[] = [
    'filesystem:read',
    'filesystem:write',
    'network:http',
    'shell:exec',
    'system:manage',
    'storage:read',
    'storage:write',
  ]
  private auditTrail: AuditTrail | null = null

  setAuditTrail(audit: AuditTrail): void {
    this.auditTrail = audit
  }

  /**
   * 注册工具 — 内置城市规划冲突调解
   *
   * 区域冲突策略 (Zone Conflict Resolution):
   *   - 内置插件 (@builtin/*) 可以接管任何同名工具 (take_over)
   *   - 用户插件默认 keep_existing (先到先得)
   *   - 可通过配置指定策略
   */
  register(reg: ToolRegistration, conflictStrategy?: ConflictResolution): void {
    if (this.tools.has(reg.name)) {
      const existing = this.tools.get(reg.name)!

      // === 城市规划: 区域冲突检测与调解 ===
      const isBuiltin = reg.pluginName.startsWith('@builtin/')
      const existingIsBuiltin = existing.pluginName.startsWith('@builtin/')

      // 内置插件 vs 用户插件 → 内置获胜
      const strategy = conflictStrategy ?? (isBuiltin && !existingIsBuiltin ? 'take_over' : 'keep_existing')

      const conflictRecord = pluginHealthGuard.mediateConflict(reg.name, existing.pluginName, reg.pluginName, strategy)

      if (strategy === 'reject') {
        log('WARN', 'tool_registration_rejected', {
          tool: reg.name,
          existing: existing.pluginName,
          incoming: reg.pluginName,
        })
        eventBus.emit('plugin.zone-conflict', conflictRecord)
        return // 静默拒绝
      }

      if (strategy === 'keep_existing') {
        log('WARN', 'tool_registration_conflict_kept_existing', {
          tool: reg.name,
          existing: existing.pluginName,
          rejected: reg.pluginName,
        })
        eventBus.emit('plugin.zone-conflict', conflictRecord)
        return // 保留现有，拒绝新注册
      }

      // take_over: 新插件接管区域，先移除旧的
      log('WARN', 'tool_registration_takeover', {
        tool: reg.name,
        old: existing.pluginName,
        new: reg.pluginName,
      })
      this.tools.delete(reg.name)
      eventBus.emit('plugin.zone-conflict', conflictRecord)
    }

    this.tools.set(reg.name, reg)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  unregisterAll(pluginName: string): void {
    for (const [name, reg] of this.tools) {
      if (reg.pluginName === pluginName) this.tools.delete(name)
    }
  }

  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  getAllSchemas(): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: {
        type: 'object'
        properties: Record<string, { type: string; description: string }>
        required: string[]
      }
    }
  }> {
    const result: Array<any> = []
    for (const reg of this.tools.values()) {
      result.push({
        type: 'function',
        function: {
          name: reg.name,
          description: reg.description,
          parameters: {
            type: 'object',
            properties: reg.parameters,
            required: reg.required,
          },
        },
      })
    }
    return result
  }

  async execute(name: string, args: Record<string, any>, callerPermissions?: Permission[]): Promise<string> {
    const reg = this.tools.get(name)
    if (!reg) throw new Error(`Unknown tool: ${name}`)
    const start = Date.now()
    // 权限强制检查
    this.enforce(name, callerPermissions)
    log('INFO', 'tool_execute', { tool: name, plugin: reg.pluginName })
    try {
      const result = await reg.handler(args)
      this.auditTrail?.record({
        source: 'plugin',
        action: 'tool_call',
        target: name,
        pluginName: reg.pluginName,
        toolName: name,
        details: { args: Object.keys(args) },
        allowed: true,
        duration: Date.now() - start,
      })
      return result
    } catch (err) {
      this.auditTrail?.record({
        source: 'plugin',
        action: 'tool_call',
        target: name,
        pluginName: reg.pluginName,
        toolName: name,
        details: { args: Object.keys(args), error: String(err) },
        allowed: false,
        duration: Date.now() - start,
        reason: String(err),
      })
      throw err
    }
  }

  listTools(): string[] {
    return Array.from(this.tools.keys())
  }

  getAllRegistrations(): ToolRegistration[] {
    return Array.from(this.tools.values())
  }

  /**
   * 在工具执行前强制执行权限检查。
   * 如果调用方缺少所需权限则抛出错误。
   */
  enforce(toolName: string, callerPermissions?: Permission[]): void {
    const reg = this.tools.get(toolName)
    if (!reg) throw new Error(`工具不存在: ${toolName}`)

    // 内置插件完全信任
    if (reg.pluginName.startsWith('@builtin/')) return
    // 无权限要求 = 公开工具
    if (!reg.requiredPermissions || reg.requiredPermissions.length === 0) return

    const perms = callerPermissions ?? this.defaultPermissions
    const missing = reg.requiredPermissions.filter((p) => !perms.includes(p))
    if (missing.length > 0) {
      throw new Error(`[PermissionDenied] 无权执行工具 "${toolName}"。需要权限: ${missing.join(', ')}`)
    }
  }

  /**
   * 设置 Registry 的默认权限集。
   * 不调用此方法时，默认拥有全部权限（完全兼容现有行为）。
   */
  setDefaultPermissions(perms: Permission[]): void {
    this.defaultPermissions = perms
  }

  /**
   * 检查工具是否允许被具有指定权限的调用者执行。
   * @param toolName 工具名
   * @param requiredPermission 调用者拥有的权限（空字符串 = 不校验）
   * @returns true 如果允许执行
   */
  checkPermission(toolName: string, requiredPermission: string): boolean {
    const reg = this.tools.get(toolName)
    if (!reg) return false
    if (reg.pluginName.startsWith('@builtin/')) return true
    if (!requiredPermission) return true
    return !!reg.requiredPermissions?.includes(requiredPermission as Permission)
  }

  /**
   * 校验调用者是否有权执行某个工具的所有权限要求。
   * @param toolName 工具名
   * @param callerPermissions 调用者拥有的权限列表
   * @returns { allowed: boolean; missing: string[] }
   */
  verifyPermissions(toolName: string, callerPermissions: Permission[]): { allowed: boolean; missing: Permission[] } {
    const reg = this.tools.get(toolName)
    if (!reg) return { allowed: false, missing: [] }
    if (reg.pluginName.startsWith('@builtin/')) return { allowed: true, missing: [] }
    if (!reg.requiredPermissions || reg.requiredPermissions.length === 0) return { allowed: true, missing: [] }
    const missing = reg.requiredPermissions.filter((p) => !callerPermissions.includes(p))
    return { allowed: missing.length === 0, missing }
  }
}

export const toolRegistry = new ToolRegistry()
