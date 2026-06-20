import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { resolveWorkspace, stripWorkspaceLabelPrefix } from '../utils/workspace'

const asyncExec = promisify(exec)

const MAX_BUFFER = 1024 * 1024
const MAX_OUTPUT = 3000

const ALLOWED_PREFIXES = [
  'npm',
  'git',
  'npx',
  'node',
  'pip',
  'pnpm',
  'python',
  'python3',
  'mkdir',
  'echo',
  'touch',
  'cp',
  'mv',
  'rm',
  'tsc',
  'ls',
  'cat',
  'netstat',
  'taskkill',
  'curl',
  'dir',
  'type',
  'findstr',
  'where',
  // Windows 安全命令白名单
  'cd',
  'rmdir',
  'copy',
  'xcopy',
  'move',
  'systeminfo',
  'hostname',
  'tasklist',
  'ver',
  'wmic',
  'ping',
  'tracert',
  'ipconfig',
  'nslookup',
  'timeout',
  'schtasks',
  'start',
  'set',
  'whoami',
  // Windows 基础管道/过滤命令（跨平台兼容）
  'find',
  'more',
  'sort',
  'findstr',
  'wc',
]

/** 跨平台命令翻译：Windows 上将常见 Unix 命令映射为等效 Windows 命令 */
function translateCommand(command: string): string {
  if (process.platform !== 'win32') return command

  // python3 -> python（Windows 上没有 python3）
  command = command.replace(/^python3\b/gm, 'python')

  // 绝对 Unix 路径开头的命令应给出更友好的错误
  command = command.replace(/^cd\s+\/[^\s]*/gm, (match) => {
    return match.replace(/^cd\s+\//, 'cd ')
  })

  // ls [-la] 等 -> dir （Windows dir 不支持 -la 标志，直接简化为 dir）
  command = command.replace(/^ls\b(\s+-[a-zA-Z]+)?(\s|$)/gm, 'dir$2')

  // cat -> type
  command = command.replace(/^cat(\s|$)/gm, 'type$1')
  command = command.replace(/\| cat(\s|$)/g, '| type$1')

  // head -N 或 head -n N 或 head -c N -> findstr /n
  // 管道内 head: "| head -c 500"、"| head -n 10"、"| head -20"
  command = command.replace(/\|\s*head\s+(?:-[nc]\s+)?(\d+)/gi, '| findstr /n . | findstr /r "^[1-$1]:"')
  // 管道内裸 head（默认 10 行）
  command = command.replace(/\|\s*head\b(?!\s*-)/gi, '| findstr /n . | findstr /r "^[1-10]:"')
  // 独立 head 命令: head -c N file -> powershell Get-Content
  command = command.replace(/^head\s+(?:-[nc]\s+)?(\d+)\s+(.+)$/gm, 'powershell -Command "Get-Content $2 -TotalCount $1"')

  // grep -> findstr
  command = command.replace(/\|\s*grep\s+["']?([^"']+)["']?/gi, '| findstr "$1"')
  command = command.replace(/^grep\s+-r\s+["']?([^"']+)["']?\s+(\S+)/gm, 'findstr /s "$1" $2')
  command = command.replace(/^grep\s+["']?([^"']+)["']?\s+(\S+)/gm, 'findstr "$1" $2')

  // rm -rf -> rmdir /s /q
  command = command.replace(/^rm\s+-rf\s+(.+)$/gm, 'rmdir /s /q $1')
  command = command.replace(/^rm\s+([^-].*)$/gm, 'del $1')

  // cp -r -> xcopy /E /I
  command = command.replace(/^cp\s+-r\s+(.+?)\s+(.+)$/gm, 'xcopy /E /I $1 $2')
  command = command.replace(/^cp\s+(\S+)\s+(\S+)$/gm, 'copy $1 $2')

  // mv -> move
  command = command.replace(/^mv\s+(.+?)\s+(.+)$/gm, 'move $1 $2')

  // touch -> type nul >
  command = command.replace(/^touch\s+(.+)$/gm, 'type nul > $1')

  // which -> where
  command = command.replace(/^which\s+(.+)$/gm, 'where $1')

  // timeout N -> timeout /t N /nobreak >nul
  // 同时处理 "timeout N" 和 "timeout N && cmd" / "timeout N; cmd"
  command = command.replace(/^timeout\s+(\d+)(.*)$/gm, 'timeout /t $1 /nobreak >nul$2')

  // wc -l file -> find /c /v "" file （Windows find 命令统计行数）
  command = command.replace(/^wc\s+(-[lLwmc]+\s+)?(.+)$/gm, 'find /c /v "" $2')

  // find . -name "*.ts" -> dir /s /b *.ts
  command = command.replace(/^find\s+\.\s+-name\s+"([^"]+)"\s*(.*)$/gm, 'dir /s /b $1 $2')
  command = command.replace(/^find\s+\.\s+-name\s+'([^']+)'\s*(.*)$/gm, 'dir /s /b $1 $2')

  // sort 保留原样 (Windows 有 sort 命令)

  // kill -SIGTERM PID → taskkill /PID PID（Windows 不支持 Unix 信号名）
  command = command.replace(/^kill\s+-(?:SIGTERM|SIGKILL|SIGINT|SIGHUP|SIGQUIT|TERM|KILL|INT|HUP|QUIT)\s+(\d+)/gm, 'taskkill /PID $1')
  command = command.replace(/^kill\s+(-\d+)\s+(\d+)/gm, 'taskkill /PID $2')

  // pkill → taskkill /IM（Unix 进程名匹配，Windows 按映像名）
  command = command.replace(/^pkill\s+(-[a-zA-Z]+\s+)?['"]?([^'"\s]+)['"]?/gm, 'taskkill /IM $2 /F')

  return command
}

function isAllowed(prefix: string): boolean {
  const stripped = prefix.replace(/\.(cmd|exe|bat|com)$/i, '')
  return ALLOWED_PREFIXES.includes(stripped)
}

export const runCommandTool = buildTool({
  name: 'run_command',
  description:
    '在 workspace 目录下执行 shell 命令。workspace="project" 在项目根目录执行。如需使用 git，请在 workspace 子目录内 git init 操作，不要操作根目录的 git 仓库。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: {
        type: 'string',
        description: '工作目录，相对于目标 workspace 根目录。MCP 项目请传入子目录名如 "my-server"',
      },
      timeout: { type: 'number', description: '超时秒数，默认 60' },
      workspace: { type: 'string', description: '目标工作区，"mcp"（默认）、"evolution"、"project"' },
    },
    required: ['command'],
  },
  handler: async (args: { command: string; cwd?: string; timeout?: number; workspace?: string }) => {
    try {
      if (!args.command) throw new Error('command 参数缺失')
      let command = translateCommand(args.command)
      const prefix = command.split(/\s+/)[0]
      if (!isAllowed(prefix)) {
        throw new Error(`不允许执行命令: ${prefix}。允许: ${ALLOWED_PREFIXES.join(', ')}`)
      }
      const wsDir = resolveWorkspace(args.workspace)
      if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true })
      const cleanCwd = args.cwd ? stripWorkspaceLabelPrefix(args.cwd, args.workspace) : undefined
      const workDir = cleanCwd ? resolve(wsDir, cleanCwd) : wsDir
      if (cleanCwd && !existsSync(workDir)) {
        throw new Error(`子目录不存在: ${args.cwd}。请先用 write_file 创建文件（mkdir 会自动创建目录）`)
      }
      const { stdout } = await asyncExec(command, {
        cwd: workDir,
        timeout: (args.timeout ?? 60) * 1000,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf-8',
        windowsHide: true,
      })
      const output = stdout.trim()
      if (output.length > MAX_OUTPUT) {
        return formatToolResult(output.slice(0, MAX_OUTPUT) + `\n...（截断，共 ${output.length} 字符）`)
      }
      return formatToolResult(output || '命令执行完成（无输出）')
    } catch (err: any) {
      return formatToolError(`命令执行失败: ${err.message || String(err)}`)
    }
  },
  isReadOnly: false,
})
