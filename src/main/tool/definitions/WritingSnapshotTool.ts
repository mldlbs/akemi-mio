/**
 * WritingSnapshotTool — 版本快照管理器 MCP 工具
 *
 * 在修改章节文件前自动备份，提供快照的创建/列表/恢复/删除功能。
 * 快照存储在项目根目录的 .writing-snapshots/ 下，按时间戳组织。
 *
 * 操作类型：
 * - create: 创建快照（备份指定文件或章节范围）
 * - list:   列出所有快照
 * - restore: 恢复指定快照
 * - delete:  删除指定快照
 * - info:    查看快照详情
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync, rmSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { getMemoryService } from '../deps'

// ===== 常量 =====

const SNAPSHOT_BASE = resolve(process.cwd(), '.writing-snapshots')
const META_FILE = '.meta.json'

// ===== 类型 =====

interface SnapshotMeta {
  id: string
  label: string
  createdAt: number
  files: Array<{ path: string; originalName: string; size: number }>
  description?: string
}

// ===== 辅助 =====

/** 确保快照根目录存在 */
function ensureBaseDir(): boolean {
  try {
    if (!existsSync(SNAPSHOT_BASE)) {
      mkdirSync(SNAPSHOT_BASE, { recursive: true })
    }
    return true
  } catch {
    return false
  }
}

/** 生成快照 ID */
function createSnapshotId(): string {
  return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 收集章节目录中的文件 */
function collectChapterFiles(dirPath: string, start: number, end: number): string[] {
  try {
    const fullPath = resolve(process.cwd(), dirPath)
    if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) return []

    const files = readdirSync(fullPath)
    const chapterFiles: string[] = []

    for (const file of files) {
      const match = file.match(/(\d+)/)
      if (!match) continue
      const num = parseInt(match[1], 10)
      if (num >= start && num <= end) {
        chapterFiles.push(resolve(fullPath, file))
      }
    }

    return chapterFiles.sort((a, b) => {
      const na = parseInt(a.match(/(\d+)/)?.[1] || '0', 10)
      const nb = parseInt(b.match(/(\d+)/)?.[1] || '0', 10)
      return na - nb
    })
  } catch {
    return []
  }
}

/** 读取快照元数据 */
function readSnapshotMeta(snapshotDir: string): SnapshotMeta | null {
  try {
    const metaPath = join(snapshotDir, META_FILE)
    if (!existsSync(metaPath)) return null
    return JSON.parse(readFileSync(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

/** 写入快照元数据 */
function writeSnapshotMeta(snapshotDir: string, meta: SnapshotMeta): boolean {
  try {
    writeFileSync(join(snapshotDir, META_FILE), JSON.stringify(meta, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 将快照操作记录到 Memory */
function recordSnapshotAction(action: string, snapshotId: string, details: string): void {
  try {
    const ms = getMemoryService()
    if (!ms) return
    ms.addEntry('user_fact', `writing_snapshot:${snapshotId}:${action}: ${details}`, 0.3, { tier: 'semi' })
  } catch {
    // 非关键操作，静默忽略
  }
}

// ===== 工具定义 =====

export const writingSnapshotTool = buildTool({
  name: 'writing_snapshot',
  description:
    '版本快照管理器 — 在修改章节文件前自动备份，提供快照的创建/列表/恢复/删除功能。\n\n' +
    '操作类型:\n' +
    '- create: 创建快照（备份指定文件）。可提供 paths（JSON 文件路径数组）或 chapterDir+chapterStart+chapterEnd\n' +
    '- list: 列出所有可用快照（支持按 limit 限制数量）\n' +
    '- restore: 恢复指定快照到原始位置（会覆盖当前文件，请谨慎使用）\n' +
    '- delete: 删除指定快照\n' +
    '- info: 查看快照详情（包含文件列表）\n\n' +
    '建议工作流：\n' +
    '  1. 修改章节前 → 调用 create 创建快照\n' +
    '  2. 修改出错 → 调用 list 找到快照 → 调用 restore 恢复\n' +
    '  3. 定期清理 → 调用 list 查看 → 调用 delete 删除过期快照',
  inputJSONSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          '操作类型:\n' +
          '- create: 创建快照。需 paths（JSON 字符串数组）或 chapterDir+chapterStart+chapterEnd。可选 label\n' +
          '- list: 列出所有快照。可选 limit（默认 20）\n' +
          '- restore: 恢复快照。需 snapshotId\n' +
          '- delete: 删除快照。需 snapshotId\n' +
          '- info: 查看快照详情。需 snapshotId',
      },
      snapshotId: {
        type: 'string',
        description: '快照 ID（restore/delete/info 时需要）。格式：snap_<timestamp>_<random>',
      },
      paths: {
        type: 'string',
        description: '要备份的文件路径列表（JSON 字符串数组，action=create 时与 chapterDir 二选一），如 ["docs/chapters/19.md", "docs/chapters/20.md"]',
      },
      label: {
        type: 'string',
        description: '快照标签/描述（action=create 时可选的说明文字）',
      },
      chapterDir: {
        type: 'string',
        description: '章节目录（action=create 时与 paths 二选一），如 "docs/chapters"',
      },
      chapterStart: {
        type: 'number',
        description: '起始章节号（与 chapterDir 配合使用）',
      },
      chapterEnd: {
        type: 'number',
        description: '结束章节号（与 chapterDir 配合使用）',
      },
      limit: {
        type: 'number',
        description: '列表最大数量（action=list 时可选，默认 20）',
      },
    },
    required: ['action'],
  },
  handler: async (args: {
    action: string
    snapshotId?: string
    paths?: string
    label?: string
    chapterDir?: string
    chapterStart?: number
    chapterEnd?: number
    limit?: number
  }) => {
    const { action, snapshotId, paths, label, chapterDir, chapterStart, chapterEnd, limit } = args

    try {
      if (!ensureBaseDir()) {
        return formatToolError('无法创建快照存储目录。请检查文件系统权限。')
      }

      switch (action) {
        // ──── create ────
        case 'create': {
          let filesToBackup: string[] = []

          if (paths) {
            try {
              const parsed = JSON.parse(paths)
              if (!Array.isArray(parsed) || parsed.length === 0) {
                return formatToolError('paths 应为非空 JSON 字符串数组')
              }
              filesToBackup = parsed.map((p: string) => resolve(process.cwd(), p))
            } catch {
              return formatToolError('paths 解析失败，请提供 JSON 字符串数组')
            }
          } else if (chapterDir) {
            const start = chapterStart ?? 1
            const end = chapterEnd ?? 99
            filesToBackup = collectChapterFiles(chapterDir, start, end)
            if (filesToBackup.length === 0) {
              return formatToolError(`在 ${chapterDir} 中未找到第${start}-${end}章的文件`)
            }
          } else {
            return formatToolError('create 操作需要提供 paths 或 chapterDir 参数')
          }

          // 验证文件存在
          const validFiles: string[] = []
          for (const f of filesToBackup) {
            if (existsSync(f) && statSync(f).isFile()) {
              validFiles.push(f)
            }
          }

          if (validFiles.length === 0) {
            return formatToolError('所有指定的文件都不存在或无法读取')
          }

          // 创建快照目录
          const id = createSnapshotId()
          const snapshotDir = join(SNAPSHOT_BASE, id)
          mkdirSync(snapshotDir, { recursive: true })

          // 复制文件
          const fileMetas: SnapshotMeta['files'] = []
          for (const filePath of validFiles) {
            const originalName = basename(filePath)
            const destPath = join(snapshotDir, originalName)
            copyFileSync(filePath, destPath)
            const size = statSync(destPath).size
            fileMetas.push({ path: filePath, originalName, size })
          }

          // 写入元数据
          const meta: SnapshotMeta = {
            id,
            label: label || `快照 ${new Date().toLocaleString('zh-CN')}`,
            createdAt: Date.now(),
            files: fileMetas,
            description: label || undefined,
          }
          writeSnapshotMeta(snapshotDir, meta)
          recordSnapshotAction('create', id, `备份 ${validFiles.length} 个文件`)

          const lines: string[] = [
            `✅ 快照已创建`,
            `🆔 ${id}`,
            `📂 ${snapshotDir}`,
            `📄 共备份 ${validFiles.length} 个文件:`,
            ...validFiles.map((f) => `  - ${basename(f)}`),
            '',
            `💡 使用 writing_snapshot action=list 查看所有快照`,
            `💡 使用 writing_snapshot action=restore snapshotId=${id} 恢复此快照`,
          ]

          return formatToolResult(lines.join('\n'))
        }

        // ──── list ────
        case 'list': {
          if (!existsSync(SNAPSHOT_BASE)) {
            return formatToolResult('暂无快照。使用 action=create 创建第一个快照。')
          }

          const dirs = readdirSync(SNAPSHOT_BASE)
            .filter((d) => d.startsWith('snap_'))
            .sort()
            .reverse()
            .slice(0, limit ?? 20)

          if (dirs.length === 0) {
            return formatToolResult('暂无快照。使用 action=create 创建第一个快照。')
          }

          const lines: string[] = [`📸 【快照列表】共 ${dirs.length} 个快照`, '']

          for (const dir of dirs) {
            const meta = readSnapshotMeta(join(SNAPSHOT_BASE, dir))
            if (meta) {
              const date = new Date(meta.createdAt).toLocaleString('zh-CN')
              const fileList = meta.files.map((f) => f.originalName).join(', ')
              lines.push(`  🆔 ${meta.id}`)
              lines.push(`     📅 ${date}`)
              lines.push(`     📝 ${meta.label}`)
              lines.push(`     📄 ${fileList.slice(0, 120)}`)
              lines.push('')
            } else {
              lines.push(`  🆔 ${dir} (元数据不可读)`, '')
            }
          }

          lines.push('💡 使用 writing_snapshot action=info snapshotId=<ID> 查看快照详情')
          lines.push('💡 使用 writing_snapshot action=restore snapshotId=<ID> 恢复快照')

          return formatToolResult(lines.join('\n'))
        }

        // ──── restore ────
        case 'restore': {
          if (!snapshotId) return formatToolError('restore 需要 snapshotId')
          if (!snapshotId.startsWith('snap_')) {
            return formatToolError(`无效的快照 ID: "${snapshotId}"。格式：snap_<timestamp>_<random>`)
          }

          const snapshotDir = join(SNAPSHOT_BASE, snapshotId)
          if (!existsSync(snapshotDir)) {
            return formatToolError(`快照不存在: ${snapshotId}`)
          }

          const meta = readSnapshotMeta(snapshotDir)
          if (!meta) {
            return formatToolError(`快照元数据损坏: ${snapshotId}`)
          }

          let restoredCount = 0
          const errors: string[] = []

          for (const fileMeta of meta.files) {
            const srcPath = join(snapshotDir, fileMeta.originalName)
            if (!existsSync(srcPath)) {
              errors.push(`快照中缺少文件: ${fileMeta.originalName}`)
              continue
            }
            try {
              // 确保目标目录存在
              const targetDir = dirname(fileMeta.path)
              if (!existsSync(targetDir)) {
                mkdirSync(targetDir, { recursive: true })
              }
              copyFileSync(srcPath, fileMeta.path)
              restoredCount++
            } catch (err: any) {
              errors.push(`恢复 ${fileMeta.originalName} 失败: ${err.message}`)
            }
          }

          recordSnapshotAction('restore', snapshotId, `恢复 ${restoredCount}/${meta.files.length} 个文件`)

          const lines: string[] = [
            restoredCount > 0
              ? `✅ 已恢复 ${restoredCount}/${meta.files.length} 个文件`
              : '❌ 未能恢复任何文件',
            `  快照: ${snapshotId}`,
            `  标签: ${meta.label}`,
          ]

          if (errors.length > 0) {
            lines.push('', '⚠️ 恢复过程中出现以下错误:')
            for (const err of errors) {
              lines.push(`  - ${err}`)
            }
          }

          return formatToolResult(lines.join('\n'))
        }

        // ──── delete ────
        case 'delete': {
          if (!snapshotId) return formatToolError('delete 需要 snapshotId')
          if (!snapshotId.startsWith('snap_')) {
            return formatToolError(`无效的快照 ID: "${snapshotId}"`)
          }

          const snapshotDir = join(SNAPSHOT_BASE, snapshotId)
          if (!existsSync(snapshotDir)) {
            return formatToolError(`快照不存在: ${snapshotId}`)
          }

          const meta = readSnapshotMeta(snapshotDir)
          const label = meta?.label || snapshotId

          rmSync(snapshotDir, { recursive: true, force: true })
          recordSnapshotAction('delete', snapshotId, `删除快照: ${label}`)

          return formatToolResult(`🗑️ 已删除快照: ${label} (${snapshotId})`)
        }

        // ──── info ────
        case 'info': {
          if (!snapshotId) return formatToolError('info 需要 snapshotId')
          if (!snapshotId.startsWith('snap_')) {
            return formatToolError(`无效的快照 ID: "${snapshotId}"`)
          }

          const snapshotDir = join(SNAPSHOT_BASE, snapshotId)
          if (!existsSync(snapshotDir)) {
            return formatToolError(`快照不存在: ${snapshotId}`)
          }

          const meta = readSnapshotMeta(snapshotDir)
          if (!meta) {
            return formatToolError(`快照元数据不可读: ${snapshotId}`)
          }

          const date = new Date(meta.createdAt).toLocaleString('zh-CN')
          const totalSize = meta.files.reduce((sum, f) => sum + f.size, 0)

          const lines: string[] = [
            `📸 【快照详情】`,
            `🆔 ${meta.id}`,
            `📅 创建时间: ${date}`,
            `📝 标签: ${meta.label}`,
            `📦 总大小: ${(totalSize / 1024).toFixed(1)} KB`,
            `📄 文件数量: ${meta.files.length}`,
            '',
            '📋 【文件列表】',
          ]

          for (const f of meta.files) {
            const sizeKB = (f.size / 1024).toFixed(1)
            lines.push(`  - ${f.originalName} (${sizeKB} KB)`)
            lines.push(`    原始路径: ${f.path}`)
          }

          lines.push('', '💡 使用 writing_snapshot action=restore snapshotId=<ID> 恢复此快照')
          lines.push('💡 使用 writing_snapshot action=delete snapshotId=<ID> 删除此快照')

          return formatToolResult(lines.join('\n'))
        }

        default:
          return formatToolError(
            `未知操作: "${action}"。支持的操作：create, list, restore, delete, info`,
          )
      }
    } catch (err: any) {
      return formatToolError(`快照操作失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})
