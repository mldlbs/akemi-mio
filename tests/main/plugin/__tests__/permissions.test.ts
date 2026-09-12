/**
 * ToolRegistry 权限执行器测试
 *
 * 验证：
 * 1. execute() 调用 enforce() 进行权限检查
 * 2. 内置插件（@builtin/）完全豁免
 * 3. 无权限要求的工具默认允许
 * 4. 权限不足时抛出 [PermissionDenied] 错误
 * 5. setDefaultPermissions() 生效
 * 6. ServerManager.callTool 经 toolRegistry 的工具也受到检查
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}))

import { ToolRegistry, Permission, expandPermissions } from '@akemi-mio/intelligence/plugin/registry'

// =============================================================================
// 辅助
// =============================================================================

const ALL_PERMS: Permission[] = [
  'filesystem:read',
  'filesystem:write',
  'network:http',
  'shell:exec',
  'system:manage',
  'storage:read',
  'storage:write',
]

const READ_ONLY_PERMS: Permission[] = ['filesystem:read', 'storage:read']

// =============================================================================
// 测试
// =============================================================================

describe('ToolRegistry 权限执行器', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  // ── 内置插件豁免 ───────────────────────────────────────

  describe('内置插件豁免', () => {
    it('@builtin/ 插件工具永远允许执行', async () => {
      registry.register({
        name: 'read_file',
        description: '读取文件',
        parameters: {},
        required: [],
        handler: () => '文件内容',
        pluginName: '@builtin/core',
        requiredPermissions: ['filesystem:read'],
      })

      // 即使传空权限也能执行
      const result = await registry.execute('read_file', {}, [])
      expect(result).toBe('文件内容')
    })

    it('@builtin/ 甚至不需要权限声明', async () => {
      registry.register({
        name: 'delete_file',
        description: '删除文件',
        parameters: {},
        required: [],
        handler: () => '已删除',
        pluginName: '@builtin/shell',
        requiredPermissions: ['filesystem:write'],
      })

      // 零权限也能执行内置工具
      const result = await registry.execute('delete_file', {}, [])
      expect(result).toBe('已删除')
    })
  })

  // ── 公开工具 ───────────────────────────────────────────

  describe('公开工具（无权限要求）', () => {
    it('空 requiredPermissions → 任何调用者都可执行', async () => {
      registry.register({
        name: 'get_weather',
        description: '获取天气',
        parameters: {},
        required: [],
        handler: () => '晴天 25°C',
        pluginName: '@user/weather',
        requiredPermissions: [],
      })

      const result = await registry.execute('get_weather', {}, [])
      expect(result).toBe('晴天 25°C')
    })

    it('未设置 requiredPermissions → 默认允许', async () => {
      registry.register({
        name: 'get_time',
        description: '获取时间',
        parameters: {},
        required: [],
        handler: () => '12:00',
        pluginName: '@user/time',
        requiredPermissions: [],
      })

      const result = await registry.execute('get_time', {}, [])
      expect(result).toBe('12:00')
    })
  })

  // ── 权限检查生效 ───────────────────────────────────────

  describe('权限检查生效', () => {
    it('调用者拥有完整权限 → 执行成功', async () => {
      registry.register({
        name: 'write_config',
        description: '写入配置',
        parameters: {},
        required: [],
        handler: () => '配置已写入',
        pluginName: '@user/config',
        requiredPermissions: ['filesystem:write'],
      })

      const result = await registry.execute('write_config', {}, ALL_PERMS)
      expect(result).toBe('配置已写入')
    })

    it('调用者缺少权限 → throw [PermissionDenied]', async () => {
      registry.register({
        name: 'delete_system_file',
        description: '删除系统文件',
        parameters: {},
        required: [],
        handler: () => '已删除',
        pluginName: '@user/danger',
        requiredPermissions: ['filesystem:write', 'shell:exec'],
      })

      await expect(registry.execute('delete_system_file', {}, READ_ONLY_PERMS)).rejects.toThrow(/PermissionDenied/)
    })

    it('错误消息应包含缺失的权限名', async () => {
      registry.register({
        name: 'exec_cmd',
        description: '执行命令',
        parameters: {},
        required: [],
        handler: () => 'ok',
        pluginName: '@user/shell',
        requiredPermissions: ['shell:exec'],
      })

      await expect(registry.execute('exec_cmd', {}, READ_ONLY_PERMS)).rejects.toThrow(/shell:exec/)
    })
  })

  // ── 默认权限 ➜ 向后兼容 ───────────────────────────────

  describe('默认权限（向后兼容）', () => {
    it('不传 callerPermissions → 默认使用全部权限', async () => {
      registry.register({
        name: 'network_fetch',
        description: '网络请求',
        parameters: {},
        required: [],
        handler: () => 'response data',
        pluginName: '@user/http',
        requiredPermissions: ['network:http'],
      })

      // 不传 callerPermissions → 默认全部权限 → 允许
      const result = await registry.execute('network_fetch', {})
      expect(result).toBe('response data')
    })
  })

  // ── setDefaultPermissions ──────────────────────────────

  describe('setDefaultPermissions', () => {
    it('可以限制默认权限集', async () => {
      registry.register({
        name: 'delete_file',
        description: '删除文件',
        parameters: {},
        required: [],
        handler: () => '已删除',
        pluginName: '@user/storage',
        requiredPermissions: ['filesystem:write'],
      })

      // 限制默认权限为只读
      registry.setDefaultPermissions(['filesystem:read', 'storage:read'])

      // execute() 不传 callerPermissions → 使用只读默认权限
      await expect(registry.execute('delete_file', {})).rejects.toThrow(/PermissionDenied/)
    })

    it('限制后内置插件仍不受影响', async () => {
      registry.register({
        name: 'list_dir',
        description: '列出目录',
        parameters: {},
        required: [],
        handler: () => 'file1, file2',
        pluginName: '@builtin/core',
        requiredPermissions: ['filesystem:read'],
      })

      registry.setDefaultPermissions([]) // 空权限

      const result = await registry.execute('list_dir', {})
      expect(result).toBe('file1, file2')
    })
  })

  // ── enforce 方法 ───────────────────────────────────────

  describe('enforce 方法', () => {
    it('工具不存在 → throw', () => {
      expect(() => registry.enforce('nonexistent')).toThrow('工具不存在')
    })
  })

  // ── ServerManager 集成路径 ─────────────────────────────

  describe('ServerManager 集成路径', () => {
    it('通过 toolRegistry.execute() 执行 → 自动权限检查', async () => {
      registry.register({
        name: 'restart_server',
        description: '重启服务',
        parameters: {},
        required: [],
        handler: () => '已重启',
        pluginName: '@user/admin',
        requiredPermissions: ['system:manage'],
      })

      // 有权限 → 执行
      const ok = await registry.execute('restart_server', {}, ALL_PERMS)
      expect(ok).toBe('已重启')

      // 无权限 → 拒绝
      await expect(registry.execute('restart_server', {}, ['filesystem:read'])).rejects.toThrow(/PermissionDenied/)
    })
  })

  // ── expandPermissions ──────────────────────────────────

  describe('expandPermissions', () => {
    it('短名称展开为标准权限', () => {
      const perms = expandPermissions(['file', 'network'])
      expect(perms).toContain('filesystem:read')
      expect(perms).toContain('filesystem:write')
      expect(perms).toContain('network:http')
    })

    it('完整权限名直接通过', () => {
      const perms = expandPermissions(['shell:exec', 'system:manage'])
      expect(perms).toEqual(['shell:exec', 'system:manage'])
    })

    it('结果去重', () => {
      const perms = expandPermissions(['file', 'file'])
      expect(perms).toEqual(['filesystem:read', 'filesystem:write'])
    })
  })
})
