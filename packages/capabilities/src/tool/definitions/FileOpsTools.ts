// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../glob.d.ts" />
import { existsSync, renameSync, copyFileSync, unlinkSync, statSync, readdirSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join, basename, dirname, resolve } from 'path'
import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { inferWorkspace, safeWorkspacePath, wsLabel, resolveWorkspace } from '@akemi-mio/capabilities/tool/utils/workspace'

export const moveFileTool = buildTool({
  name: 'move_file',
  description: '移动或重命名文件。source 和 target 必须在同一 workspace 内。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件路径' },
      target: { type: 'string', description: '目标路径（新位置/新名称）' },
      workspace: { type: 'string', description: '目标工作区，"project"（默认）、"evolution"、"mcp"' },
    },
    required: ['source', 'target'],
  },
  handler: async (args: { source: string; target: string; workspace?: string }) => {
    try {
      const ws = inferWorkspace(args.source, args.workspace)
      const src = safeWorkspacePath(args.source, ws)
      const dst = safeWorkspacePath(args.target, ws)
      if (!existsSync(src)) throw new Error(`源文件不存在: ${wsLabel(ws)}/${args.source}`)
      const dstDir = dirname(dst)
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
      renameSync(src, dst)
      return formatToolResult(`已移动 ${wsLabel(ws)}/${args.source} → ${args.target}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const copyFileTool = buildTool({
  name: 'copy_file',
  description: '复制文件。source 和 target 必须在同一 workspace 内。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件路径' },
      target: { type: 'string', description: '目标路径' },
      workspace: { type: 'string', description: '目标工作区，"project"（默认）、"evolution"、"mcp"' },
    },
    required: ['source', 'target'],
  },
  handler: async (args: { source: string; target: string; workspace?: string }) => {
    try {
      const ws = inferWorkspace(args.source, args.workspace)
      const src = safeWorkspacePath(args.source, ws)
      const dst = safeWorkspacePath(args.target, ws)
      if (!existsSync(src)) throw new Error(`源文件不存在: ${wsLabel(ws)}/${args.source}`)
      const dstDir = dirname(dst)
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
      copyFileSync(src, dst)
      return formatToolResult(`已复制 ${wsLabel(ws)}/${args.source} → ${args.target}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const deleteFileTool = buildTool({
  name: 'delete_file',
  description: '删除文件或空目录。谨慎操作，不可恢复。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件或空目录路径' },
      workspace: { type: 'string', description: '目标工作区，"project"（默认）、"evolution"、"mcp"' },
    },
    required: ['path'],
  },
  handler: async (args: { path: string; workspace?: string }) => {
    try {
      const ws = inferWorkspace(args.path, args.workspace)
      const p = safeWorkspacePath(args.path, ws)
      if (!existsSync(p)) throw new Error(`路径不存在: ${wsLabel(ws)}/${args.path}`)
      unlinkSync(p)
      return formatToolResult(`已删除 ${wsLabel(ws)}/${args.path}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const fileInfoTool = buildTool({
  name: 'file_info',
  description: '获取文件或目录的详细信息（大小、修改时间、类型等）',
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件或目录路径' },
      workspace: { type: 'string', description: '目标工作区，"project"（默认）、"evolution"、"mcp"' },
    },
    required: ['path'],
  },
  handler: async (args: { path: string; workspace?: string }) => {
    try {
      const ws = inferWorkspace(args.path, args.workspace)
      const p = safeWorkspacePath(args.path, ws)
      if (!existsSync(p)) throw new Error(`路径不存在: ${wsLabel(ws)}/${args.path}`)
      const s = statSync(p)
      const isDir = s.isDirectory()
      const lines = [
        `路径: ${wsLabel(ws)}/${args.path}`,
        `类型: ${isDir ? '目录' : '文件'}`,
        `大小: ${isDir ? '-' : `${(s.size / 1024).toFixed(1)} KB`}`,
        `创建时间: ${s.birthtime.toLocaleString('zh-CN')}`,
        `修改时间: ${s.mtime.toLocaleString('zh-CN')}`,
        `权限: ${s.mode.toString(8).slice(-3)}`,
      ]
      if (isDir) {
        const entries = readdirSync(p)
        lines.push(`子项数: ${entries.length}`)
      }
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const searchFilesGlobTool = buildTool({
  name: 'search_files',
  description: '按名称模式查找文件（支持 glob 通配符如 *.ts, **/*.test.ts）。返回匹配文件列表。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '文件名模式，如 "*.ts"、"**/*.test.ts"、"utils/**"' },
      workspace: { type: 'string', description: '目标工作区，"project"（默认）、"evolution"、"mcp"' },
      maxResults: { type: 'number', description: '最大返回数，默认 100' },
    },
    required: ['pattern'],
  },
  handler: async (args: { pattern: string; workspace?: string; maxResults?: number }) => {
    try {
      const base = resolveWorkspace(args.workspace || 'project')
      const glob = await import('glob')
      const globSync = glob.globSync || glob.sync
      const matches = globSync(args.pattern, { cwd: base, dot: false })
      if (!matches.length) return formatToolResult('未找到匹配文件')
      const max = args.maxResults ?? 100
      const sliced = matches.slice(0, max)
      const lines = sliced.map((f: string) => `${f}`)
      const summary = matches.length > max ? `\n...及另外 ${matches.length - max} 个匹配文件` : ''
      return formatToolResult(`【匹配文件】\n${lines.join('\n')}${summary}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const appendFileTool = buildTool({
  name: 'append_file',
  description: '向文件追加内容。文件不存在则自动创建。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要追加的内容' },
      workspace: { type: 'string', description: '目标工作区，"project"（默认）、"evolution"、"mcp"' },
    },
    required: ['path', 'content'],
  },
  handler: async (args: { path: string; content: string; workspace?: string }) => {
    try {
      const ws = inferWorkspace(args.path, args.workspace)
      const p = safeWorkspacePath(args.path, ws)
      const dir = dirname(p)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(p, args.content, 'utf-8')
      return formatToolResult(`已追加内容到 ${wsLabel(ws)}/${args.path}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const readMultipleFilesTool = buildTool({
  name: 'read_multiple_files',
  description: '一次读取多个文件内容。适合同时查看几个关联文件。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '文件路径列表，最多 10 个文件',
      },
      workspace: { type: 'string', description: '目标工作区，"project"（默认）、"evolution"、"mcp"' },
    },
    required: ['paths'],
  },
  handler: async (args: { paths: string[]; workspace?: string }) => {
    try {
      if (!args.paths?.length) return formatToolError('paths 不能为空')
      if (args.paths.length > 10) return formatToolError('一次性最多读取 10 个文件')
      const ws = inferWorkspace(args.paths[0], args.workspace)
      const parts: string[] = []
      for (const p of args.paths) {
        const fp = safeWorkspacePath(p, ws)
        if (!existsSync(fp)) {
          parts.push(`=== ${p} ===\n<文件不存在>`)
          continue
        }
        const content = readFileSync(fp, 'utf-8')
        parts.push(`=== ${p} ===\n${content}`)
      }
      return formatToolResult(parts.join('\n\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})


