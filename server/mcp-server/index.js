/**
 * Akemi Mio 远程 MCP 服务器 — 完整服务器管理
 * 支持：系统监控、服务管理、文件操作、网络、Docker、Nginx、防火墙等
 */

const http = require('http')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = parseInt(process.env.PORT || '3100', 10)
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ''

let requestId = 0

function createResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function createError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

// ─── 工具定义 ───

const TOOLS = [
  // ═══════ 命令执行 ═══════
  {
    name: 'exec_command',
    description: '在服务器上执行 shell 命令并返回输出（超时 60 秒）',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录，默认 /root' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认 60000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'exec_script',
    description: '在服务器上执行一段多行脚本（创建临时文件并执行）',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '要执行的脚本内容' },
        shell: { type: 'string', description: '解释器，默认 /bin/bash' },
      },
      required: ['script'],
    },
  },

  // ═══════ 文件操作 ═══════
  {
    name: 'centos_read_file',
    description: '读取服务器上的文件内容',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        max_lines: { type: 'number', description: '最多读取行数，默认 200' },
      },
      required: ['path'],
    },
  },
  {
    name: 'centos_write_file',
    description: '写入文件到服务器（自动创建父目录）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '文件内容' },
        mode: { type: 'string', description: '权限模式，如 755' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'centos_append_file',
    description: '追加内容到服务器上的文件（自动换行）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '要追加的内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'centos_delete_file',
    description: '删除服务器上的文件或空目录',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的文件或目录路径' },
        recursive: { type: 'boolean', description: '是否递归删除（用于非空目录）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'centos_copy_file',
    description: '复制或移动服务器上的文件/目录',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源路径' },
        dest: { type: 'string', description: '目标路径' },
        action: { type: 'string', enum: ['copy', 'move'], description: 'copy 复制（默认） / move 移动' },
      },
      required: ['source', 'dest'],
    },
  },
  {
    name: 'centos_chmod',
    description: '修改文件/目录权限和所有者',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或目录路径' },
        mode: { type: 'string', description: '权限模式，如 755、644' },
        owner: { type: 'string', description: '所有者，如 root:root' },
        recursive: { type: 'boolean', description: '是否递归' },
      },
      required: ['path'],
    },
  },
  {
    name: 'centos_search_files',
    description: '搜索服务器上的文件',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式，支持通配符如 *.log、*.conf' },
        path: { type: 'string', description: '搜索目录，默认 /' },
        name: { type: 'string', description: '文件名关键词（find -name）' },
        type: { type: 'string', enum: ['f', 'd', 'l'], description: 'f 文件 / d 目录 / l 链接' },
        max_depth: { type: 'number', description: '最大深度，默认 3' },
        size: { type: 'string', description: '大小过滤，如 +100M、-1K' },
        modified: { type: 'string', description: '修改时间，如 -7（7天内）、+30（30天前）' },
      },
      required: [],
    },
  },
  {
    name: 'centos_grep',
    description: '在服务器上的文件中搜索文本内容',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则表达式' },
        path: { type: 'string', description: '搜索路径，默认 /root' },
        glob: { type: 'string', description: '文件通配符，如 *.log、*.conf、*.js' },
        context: { type: 'number', description: '显示匹配行的前后各 N 行' },
        ignore_case: { type: 'boolean', description: '忽略大小写' },
        max_results: { type: 'number', description: '最多显示结果数，默认 50' },
      },
      required: ['pattern'],
    },
  },

  // ═══════ 目录管理 ═══════
  {
    name: 'list_directory',
    description: '列出服务器上目录的内容（包含文件大小和修改时间）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径，默认 /root' },
        sort: { type: 'string', enum: ['name', 'size', 'time'], description: '排序方式，默认 name' },
        reverse: { type: 'boolean', description: '倒序排列' },
      },
      required: [],
    },
  },
  {
    name: 'disk_usage',
    description: '查看服务器磁盘使用情况',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '路径，默认 /' },
        human_readable: { type: 'boolean', description: '人性化显示' },
        top_dirs: { type: 'number', description: '显示占用最大的 top N 目录' },
      },
      required: [],
    },
  },

  // ═══════ 系统监控 ═══════
  {
    name: 'system_info',
    description: '获取服务器系统信息（CPU、内存、磁盘、负载、进程数等）',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'system_top',
    description: '查看服务器实时进程排名（CPU/内存占用）',
    inputSchema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['cpu', 'mem'], description: '排序方式，cpu 或 mem' },
        count: { type: 'number', description: '显示进程数，默认 15' },
      },
      required: [],
    },
  },
  {
    name: 'network_info',
    description: '查看网络连接、端口监听和带宽情况',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['listen', 'connections', 'bandwidth', 'stats'], description: '信息类型' },
        port: { type: 'number', description: '按端口过滤' },
      },
      required: [],
    },
  },
  {
    name: 'system_logs',
    description: '查看系统日志（journalctl / dmesg / 特定日志文件）',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['journal', 'dmesg', 'messages', 'secure', 'cron', 'boot'], description: '日志来源' },
        lines: { type: 'number', description: '行数，默认 30' },
        priority: { type: 'string', enum: ['emerg', 'alert', 'crit', 'err', 'warning', 'info', 'debug'], description: '日志级别过滤' },
        since: { type: 'string', description: '起始时间，如 "5 min ago"、"yesterday"、"2026-06-18 10:00"' },
        grep: { type: 'string', description: '关键词过滤' },
      },
      required: [],
    },
  },
  {
    name: 'service_status',
    description: '查看 systemd 服务状态（所有服务、指定服务）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务名称，如 nginx、sshd、docker。不传则显示所有 failed 服务' },
        list_all: { type: 'boolean', description: '是否列出所有服务而非仅 failed' },
      },
      required: [],
    },
  },
  {
    name: 'service_control',
    description: '控制系统服务（启动/停止/重启/启用/禁用）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务名，如 nginx、sshd、docker' },
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'status'], description: '操作' },
      },
      required: ['name', 'action'],
    },
  },
  {
    name: 'security_info',
    description: '查看服务器安全状态（登录日志、失败尝试、开放端口、SELinux、更新等）',
    inputSchema: {
      type: 'object',
      properties: {
        check: { type: 'string', enum: ['failed_logins', 'open_ports', 'selinux', 'updates', 'all'], description: '检查项' },
      },
      required: [],
    },
  },

  // ═══════ 进程管理 ═══════
  {
    name: 'list_processes',
    description: '列出服务器上的进程',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '过滤关键字' },
        sort: { type: 'string', enum: ['mem', 'cpu', 'pid'], description: '排序' },
        count: { type: 'number', description: '条数' },
        tree: { type: 'boolean', description: '树形显示' },
      },
      required: [],
    },
  },
  {
    name: 'kill_process',
    description: '终止服务器上的进程',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: '进程 PID' },
        signal: { type: 'string', description: '信号，默认 SIGTERM，可使用 SIGKILL' },
        name: { type: 'string', description: '按进程名终止（killall）' },
      },
      required: [],
    },
  },

  // ═══════ PM2 管理 ═══════
  {
    name: 'pm2_status',
    description: '查看 pm2 所有进程的状态',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pm2_operate',
    description: '操作 pm2 进程（重启/停止/启动/查看日志/监控）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['restart', 'stop', 'start', 'delete', 'logs', 'monit', 'save'], description: '操作' },
        name: { type: 'string', description: '进程名' },
        lines: { type: 'number', description: '日志行数（仅 logs 有效），默认 30' },
      },
      required: ['action', 'name'],
    },
  },
  {
    name: 'pm2_start',
    description: '用 pm2 启动一个新应用',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '入口文件路径' },
        name: { type: 'string', description: '进程名称' },
        args: { type: 'string', description: '额外参数' },
        cwd: { type: 'string', description: '工作目录' },
        env: { type: 'string', description: '环境变量，格式 KEY=VALUE;KEY2=VALUE2' },
      },
      required: ['path', 'name'],
    },
  },

  // ═══════ Nginx 管理 ═══════
  {
    name: 'nginx_status',
    description: '管理 Nginx（测试配置/状态/重载/启停）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['test', 'status', 'reload', 'restart', 'start', 'stop', 'sites'], description: '操作' },
      },
      required: ['action'],
    },
  },
  {
    name: 'nginx_edit_site',
    description: '查看或编辑 Nginx 站点配置',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '站点名，如 skills.conf 或 default.conf' },
        action: { type: 'string', enum: ['read', 'enable', 'disable', 'list', 'create'], description: '操作' },
        content: { type: 'string', description: '配置内容（仅 create/overwrite 时需要）' },
        domain: { type: 'string', description: '域名（仅 create 时需要）' },
        proxy_pass: { type: 'string', description: '反向代理目标（仅 create 时需要），如 http://127.0.0.1:3003' },
      },
      required: ['name', 'action'],
    },
  },

  // ═══════ Docker 管理 ═══════
  {
    name: 'docker_ps',
    description: '查看 Docker 容器列表',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '包含已停止的容器' },
        filter: { type: 'string', description: '过滤，如 name=xxx、status=running' },
      },
      required: [],
    },
  },
  {
    name: 'docker_images',
    description: '查看 Docker 镜像列表',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'docker_operate',
    description: '操作 Docker 容器（启动/停止/重启/日志/删除）',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: '容器名或 ID' },
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'logs', 'stats', 'rm', 'exec'], description: '操作' },
        command: { type: 'string', description: 'exec 时要执行的命令' },
        lines: { type: 'number', description: '日志行数' },
      },
      required: ['container', 'action'],
    },
  },
  {
    name: 'docker_compose',
    description: '管理 Docker Compose 项目',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目目录（docker-compose.yml 所在目录）' },
        action: { type: 'string', enum: ['up', 'down', 'restart', 'logs', 'ps', 'pull'], description: '操作' },
        service: { type: 'string', description: '特定服务名（可选）' },
      },
      required: ['path', 'action'],
    },
  },

  // ═══════ 包管理 ═══════
  {
    name: 'package_list',
    description: '查看已安装的软件包或更新信息',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['installed', 'available_updates', 'search'], description: '查询类型' },
        name: { type: 'string', description: '包名（search 时需要）' },
      },
      required: ['type'],
    },
  },
  {
    name: 'package_install',
    description: '安装/卸载/更新软件包',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '包名' },
        action: { type: 'string', enum: ['install', 'remove', 'update'], description: '操作' },
      },
      required: ['name', 'action'],
    },
  },
  {
    name: 'npm_manage',
    description: '管理 Node.js 项目和 npm 包',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '项目目录' },
        action: { type: 'string', enum: ['install', 'update', 'list', 'run', 'test', 'build'], description: '操作' },
        package: { type: 'string', description: '包名（install 时）' },
        script: { type: 'string', description: 'npm run 的脚本名（run 时）' },
      },
      required: ['cwd', 'action'],
    },
  },

  // ═══════ 网络工具 ═══════
  {
    name: 'network_check',
    description: '检查网络连通性（ping/curl/端口检测）',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标，如域名、IP、URL' },
        type: { type: 'string', enum: ['ping', 'curl', 'port', 'dns', 'traceroute'], description: '检测类型' },
        port: { type: 'number', description: '端口（type=port 时需要）' },
        timeout: { type: 'number', description: '超时秒数' },
      },
      required: ['target', 'type'],
    },
  },
  {
    name: 'ssl_check',
    description: '检查 SSL 证书信息（域名证书到期时间、证书链）',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '域名' },
        port: { type: 'number', description: '端口，默认 443' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'firewall_status',
    description: '查看和管理防火墙规则（firewalld/iptables）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add_port', 'remove_port', 'add_service', 'reload', 'status'], description: '操作' },
        port: { type: 'string', description: '端口（add_port/remove_port 时），如 8080/tcp' },
        service: { type: 'string', description: '服务名（add_service 时），如 http、https' },
        zone: { type: 'string', description: '区域，默认 public' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cron_manage',
    description: '管理 cron 定时任务（查看/添加/删除）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'edit'], description: '操作' },
        line: { type: 'string', description: 'cron 表达式（add/edit 时需要），如 "0 3 * * * /root/backup.sh"' },
        user: { type: 'string', description: '用户，默认 root' },
        index: { type: 'number', description: '要删除的行号（remove 时需要）' },
      },
      required: ['action'],
    },
  },

  // ═══════ SSL 证书 ═══════
  {
    name: 'certbot_manage',
    description: '管理 Let\'s Encrypt SSL 证书（申请/续期/查看）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'renew', 'certonly'], description: '操作' },
        domain: { type: 'string', description: '域名（certonly 时需要）' },
        email: { type: 'string', description: '邮箱（certonly 时需要）' },
      },
      required: ['action'],
    },
  },

  // ═══════ Git 操作 ═══════
  {
    name: 'git_manage',
    description: '在服务器上执行 Git 操作（克隆/拉取/状态/日志）',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '仓库目录' },
        action: { type: 'string', enum: ['status', 'pull', 'log', 'clone', 'branch', 'checkout', 'diff', 'reset'], description: '操作' },
        url: { type: 'string', description: '仓库 URL（clone 时需要）' },
        branch: { type: 'string', description: '分支名（checkout/clone 时）' },
        depth: { type: 'number', description: 'clone 深度' },
        count: { type: 'number', description: 'log 显示条数，默认 10' },
        path: { type: 'string', description: 'clone 目标路径' },
      },
      required: ['cwd', 'action'],
    },
  },

  // ═══════ 备份/压缩 ═══════
  {
    name: 'archive_manage',
    description: '压缩/解压文件和目录',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['compress', 'extract', 'list'], description: '操作' },
        source: { type: 'string', description: '源文件/目录' },
        dest: { type: 'string', description: '目标压缩文件路径（compress 时）或多于一个源文件时使用 dest 目录' },
        format: { type: 'string', enum: ['tar.gz', 'zip'], description: '压缩格式，默认 tar.gz' },
      },
      required: ['action', 'source'],
    },
  },
  {
    name: 'rsync_manage',
    description: '在服务器之间同步文件（rsync）',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源路径' },
        dest: { type: 'string', description: '目标路径' },
        options: { type: 'string', description: '额外参数，默认 -avz' },
        remote_host: { type: 'string', description: '远程主机（如 user@host）' },
        direction: { type: 'string', enum: ['push', 'pull'], description: '传输方向' },
      },
      required: ['source', 'dest'],
    },
  },

  // ═══════ 用户管理 ═══════
  {
    name: 'user_manage',
    description: '管理系统用户（查看/创建/修改密码）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'info', 'groups'], description: '操作' },
        username: { type: 'string', description: '用户名' },
        password: { type: 'string', description: '密码（create 时需要）' },
        group: { type: 'string', description: '用户组（create 时需要）' },
        shell: { type: 'string', description: '登录 shell，默认 /bin/bash' },
        home: { type: 'string', description: '家目录，默认 /home/username' },
      },
      required: ['action'],
    },
  },

  // ═══════ 定时诊断 ═══════
  {
    name: 'diagnose',
    description: '快速诊断服务器健康状态（一键检查各项指标）',
    inputSchema: {
      type: 'object',
      properties: {
        focus: { type: 'string', enum: ['all', 'performance', 'network', 'storage', 'security'], description: '诊断重点' },
      },
      required: [],
    },
  },
]

// ─── 工具函数 ───

function safeExec(command, cwd = '/root', timeout = 60000) {
  try {
    const result = execSync(command, {
      cwd,
      timeout,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: '/usr/local/node20/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    })
    return { stdout: result.trim(), stderr: '' }
  } catch (e) {
    return {
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim() || e.message,
    }
  }
}

function safeExecWithJson(command, cwd) {
  const r = safeExec(command, cwd)
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

// ─── 工具执行 ───

async function handleToolCall(name, args) {
  switch (name) {
    // ── 命令执行 ──
    case 'exec_command': {
      const result = safeExec(args.command, args.cwd || '/root', args.timeout_ms || 60000)
      const text = []
      if (result.stdout) text.push(result.stdout)
      if (result.stderr) text.push(`[stderr]\n${result.stderr}`)
      return {
        content: [{ type: 'text', text: text.join('\n\n') || '(no output)' }],
        isError: !!result.stderr,
      }
    }

    case 'exec_script': {
      const tmpPath = `/tmp/mcp_script_${Date.now()}.sh`
      fs.writeFileSync(tmpPath, args.script, 'utf-8')
      fs.chmodSync(tmpPath, '755')
      const shell = args.shell || '/bin/bash'
      const result = safeExec(`${shell} ${tmpPath}`)
      try { fs.unlinkSync(tmpPath) } catch {}
      const text = []
      if (result.stdout) text.push(result.stdout)
      if (result.stderr) text.push(`[stderr]\n${result.stderr}`)
      return { content: [{ type: 'text', text: text.join('\n\n') || '(script executed, no output)' }], isError: !!result.stderr }
    }

    // ── 文件操作 ──
    case 'centos_read_file': {
      try {
        const p = path.resolve(args.path)
        if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`)
        const maxLines = args.max_lines || 200
        const data = fs.readFileSync(p, 'utf-8')
        const lines = data.split('\n')
        const content = lines.slice(0, maxLines).join('\n')
        const stats = fs.statSync(p)
        const meta = `File: ${p}\nSize: ${(stats.size / 1024).toFixed(1)}K | Lines: ${lines.length} | Modified: ${stats.mtime.toISOString().slice(0, 19)} | Mode: ${stats.mode.toString(8).slice(-3)}`
        const truncated = lines.length > maxLines ? `\n\n... (${lines.length - maxLines} more lines)` : ''
        return { content: [{ type: 'text', text: `${meta}\n${'-'.repeat(60)}\n${content}${truncated}` }], isError: false }
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }

    case 'centos_write_file': {
      try {
        const p = path.resolve(args.path)
        const dir = path.dirname(p)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(p, args.content, 'utf-8')
        if (args.mode) fs.chmodSync(p, parseInt(args.mode, 8))
        return { content: [{ type: 'text', text: `Written ${Buffer.byteLength(args.content, 'utf-8')} bytes to ${p}` }], isError: false }
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }

    case 'centos_append_file': {
      try {
        const p = path.resolve(args.path)
        fs.appendFileSync(p, '\n' + args.content, 'utf-8')
        return { content: [{ type: 'text', text: `Appended ${Buffer.byteLength(args.content, 'utf-8')} bytes to ${p}` }], isError: false }
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }

    case 'centos_delete_file': {
      try {
        const p = path.resolve(args.path)
        if (!fs.existsSync(p)) throw new Error(`Not found: ${p}`)
        if (args.recursive) {
          safeExec(`rm -rf "${p}"`)
        } else {
          const stat = fs.statSync(p)
          if (stat.isDirectory()) {
            fs.rmdirSync(p)
          } else {
            fs.unlinkSync(p)
          }
        }
        return { content: [{ type: 'text', text: `Deleted: ${p}` }], isError: false }
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }

    case 'centos_copy_file': {
      const action = args.action || 'copy'
      const cmd = action === 'move' ? 'mv' : 'cp'
      const flag = fs.existsSync(args.dest) && fs.statSync(args.dest).isDirectory() ? '' : (fs.statSync(args.source).isDirectory() ? '-r' : '')
      const result = safeExec(`${cmd} ${flag} "${args.source}" "${args.dest}"`)
      return { content: [{ type: 'text', text: result.stdout || `${action} done` }], isError: !!result.stderr }
    }

    case 'centos_chmod': {
      const parts = []
      if (args.mode) parts.push(`chmod ${args.recursive ? '-R' : ''} ${args.mode} "${args.path}"`)
      if (args.owner) parts.push(`chown ${args.recursive ? '-R' : ''} ${args.owner} "${args.path}"`)
      const result = safeExec(parts.join(' && '))
      return { content: [{ type: 'text', text: result.stdout || 'Done' }], isError: !!result.stderr }
    }

    case 'centos_search_files': {
      const parts = ['find', args.path || '/', '-maxdepth', String(args.max_depth || 3)]
      if (args.name) parts.push(`-name "${args.name}"`)
      if (args.type) parts.push(`-type ${args.type}`)
      if (args.size) parts.push(`-size ${args.size}`)
      if (args.modified) {
        const n = parseInt(args.modified)
        parts.push(n < 0 ? `-mtime ${n}` : `-mtime +${n}`)
      }
      if (args.pattern && !args.name) parts.push(`-name "${args.pattern}"`)
      parts.push('2>/dev/null | head -100')
      const result = safeExec(parts.join(' '))
      return { content: [{ type: 'text', text: result.stdout || '(no files found)' }], isError: !!result.stderr }
    }

    case 'centos_grep': {
      const parts = ['grep']
      if (args.ignore_case) parts.push('-i')
      if (args.context) parts.push(`-C ${args.context}`)
      parts.push(`-r "${args.pattern}"`)
      parts.push(args.path || '/root')
      if (args.glob) parts.push(`--include="${args.glob}"`)
      parts.push('2>/dev/null')
      parts.push(`| head -${args.max_results || 50}`)
      const result = safeExec(parts.join(' '))
      return { content: [{ type: 'text', text: result.stdout || '(no matches)' }], isError: !!result.stderr }
    }

    // ── 目录管理 ──
    case 'list_directory': {
      try {
        const p = path.resolve(args.path || '/root')
        if (!fs.existsSync(p)) throw new Error(`Directory not found: ${p}`)
        const items = fs.readdirSync(p, { withFileTypes: true })
        let entries = items.map(i => {
          const full = path.join(p, i.name)
          let stat = null
          try { stat = fs.statSync(full) } catch {}
          return {
            name: i.name,
            type: i.isDirectory() ? 'DIR' : i.isFile() ? 'FILE' : i.isSymbolicLink() ? 'LINK' : 'OTHER',
            size: stat ? stat.size : 0,
            mtime: stat ? stat.mtime : new Date(0),
            mode: stat ? stat.mode.toString(8).slice(-3) : '???',
          }
        })
        const sortBy = args.sort || 'name'
        entries.sort((a, b) => {
          if (sortBy === 'size') return args.reverse ? a.size - b.size : b.size - a.size
          if (sortBy === 'time') return args.reverse ? a.mtime - b.mtime : b.mtime - a.mtime
          return args.reverse ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)
        })
        const lines = entries.map(e => {
          const size = e.type === 'DIR' ? '    -' : `${(e.size / 1024).toFixed(1).padStart(7)}K`
          const mtime = e.mtime.toISOString().slice(0, 16)
          return `${e.type.padEnd(5)} ${e.mode} ${size} ${mtime}  ${e.name}`
        })
        const total = safeExec(`du -sh "${p}" 2>/dev/null`).stdout.split(/\s/)[0] || ''
        return { content: [{ type: 'text', text: `目录: ${p}  (total: ${total})\n${'-'.repeat(65)}\n` + lines.join('\n') }], isError: false }
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }

    case 'disk_usage': {
      const pathArg = args.path || '/'
      if (args.top_dirs) {
        const result = safeExec(`du -sh ${pathArg}/* 2>/dev/null | sort -rh | head -${args.top_dirs}`)
        return { content: [{ type: 'text', text: result.stdout || '(no data)' }], isError: false }
      }
      const result = safeExec(`df -h ${pathArg}`)
      const inode = safeExec(`df -i ${pathArg} 2>/dev/null`).stdout
      return { content: [{ type: 'text', text: `${result.stdout}\n\n${inode}` }], isError: !!result.stderr }
    }

    // ── 系统监控 ──
    case 'system_info': {
      const info = {
        hostname: safeExec('hostname').stdout.trim(),
        os: safeExec('cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d "\""').stdout.trim() || safeExec('uname -a').stdout.trim(),
        kernel: safeExec('uname -r').stdout.trim(),
        arch: safeExec('uname -m').stdout.trim(),
        uptime: safeExec('uptime').stdout.trim(),
        cpu: safeExec('lscpu | grep "Model name" | cut -d: -f2 | xargs').stdout.trim() || safeExec('grep "model name" /proc/cpuinfo | head -1 | cut -d: -f2 | xargs').stdout.trim(),
        cores: safeExec('nproc').stdout.trim(),
        load: safeExec('cat /proc/loadavg').stdout.trim(),
        memory: safeExec('free -h').stdout,
        swap: safeExec('swapon --show 2>/dev/null || echo "no swap"').stdout.trim(),
        disk: safeExec('df -h /').stdout,
        processes: safeExec('ps aux | wc -l').stdout.trim(),
        users: safeExec('who | wc -l').stdout.trim(),
        selinux: safeExec('getenforce 2>/dev/null || echo "not available"').stdout.trim(),
        last_boot: safeExec('who -b').stdout.trim(),
        time: safeExec('date').stdout.trim(),
      }
      return { content: [{ type: 'text', text: `📋 服务器信息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
主机名: ${info.hostname}
系统: ${info.os}
内核: ${info.kernel} | 架构: ${info.arch}
运行时间: ${info.uptime}
启动: ${info.last_boot}
时间: ${info.time}

💻 CPU
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
型号: ${info.cpu}
核心数: ${info.cores}
负载: ${info.load}

🧠 内存
${info.memory}

💾 磁盘
${info.disk}

📊 进程: ${info.processes} | 登录用户: ${info.users} | SELinux: ${info.selinux}` }], isError: false }
    }

    case 'system_top': {
      const sort = args.sort === 'cpu' ? '-%cpu' : '-%mem'
      const count = args.count || 15
      const result = safeExec(`ps aux --sort=${sort} | head -${count + 1}`)
      return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
    }

    case 'network_info': {
      const type = args.type || 'listen'
      let result
      if (type === 'listen') {
        result = safeExec('ss -tlnp 2>/dev/null | head -40 || netstat -tlnp 2>/dev/null | head -40')
      } else if (type === 'connections') {
        const portFilter = args.port ? `dport = :${args.port} or sport = :${args.port}` : ''
        result = safeExec(`ss -tan 2>/dev/null | head -50 || netstat -tan 2>/dev/null | head -50`)
      } else if (type === 'stats') {
        result = safeExec('ss -s 2>/dev/null || netstat -s 2>/dev/null | head -30')
      } else {
        result = safeExec('sar -n DEV 1 1 2>/dev/null || cat /proc/net/dev')
      }
      return { content: [{ type: 'text', text: result.stdout || '(no data)' }], isError: !!result.stderr }
    }

    case 'system_logs': {
      const source = args.source || 'journal'
      const lines = args.lines || 30
      let cmd
      if (source === 'journal') {
        const priority = args.priority ? `-p ${args.priority}` : ''
        const since = args.since ? `--since "${args.since}"` : ''
        cmd = `journalctl -n ${lines} ${priority} ${since} --no-pager 2>/dev/null`
      } else if (source === 'dmesg') {
        cmd = `dmesg | tail -${lines}`
      } else if (source === 'messages') {
        cmd = `tail -${lines} /var/log/messages 2>/dev/null`
      } else if (source === 'secure') {
        cmd = `tail -${lines} /var/log/secure 2>/dev/null`
      } else if (source === 'cron') {
        cmd = `tail -${lines} /var/log/cron 2>/dev/null`
      } else if (source === 'boot') {
        cmd = `journalctl -b -n ${lines} --no-pager 2>/dev/null`
      }
      if (args.grep && cmd) cmd += ` | grep -i "${args.grep}"`
      const result = safeExec(cmd || 'echo "invalid source"')
      return { content: [{ type: 'text', text: result.stdout || '(no log output)' }], isError: !!result.stderr }
    }

    case 'service_status': {
      if (args.name) {
        const result = safeExec(`systemctl status ${args.name} --no-pager 2>&1 | head -30`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      const flag = args.list_all ? '' : '--failed'
      const result = safeExec(`systemctl list-units ${flag} --type=service --no-pager 2>&1 | head -40`)
      return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
    }

    case 'service_control': {
      const result = safeExec(`systemctl ${args.action} ${args.name} 2>&1`)
      return { content: [{ type: 'text', text: result.stdout || `${args.action} ${args.name} done` }], isError: !!result.stderr }
    }

    case 'security_info': {
      const check = args.check || 'all'
      const parts = []
      if (check === 'failed_logins' || check === 'all') {
        parts.push(`🔐 失败登录 (最近20条)\n${safeExec('lastb 2>/dev/null | head -20').stdout || '(none)'}`)
      }
      if (check === 'open_ports' || check === 'all') {
        parts.push(`\n🔓 开放端口\n${safeExec('ss -tlnp 2>/dev/null | head -30').stdout || '(none)'}`)
      }
      if (check === 'selinux' || check === 'all') {
        parts.push(`\n🛡️  SELinux: ${safeExec('getenforce 2>/dev/null || echo "not available"').stdout.trim()}`)
      }
      if (check === 'updates' || check === 'all') {
        const updates = safeExec('yum check-update -q 2>/dev/null | wc -l || dnf check-update -q 2>/dev/null | wc -l')
        parts.push(`📦 可用更新: ${updates.stdout.trim()} 个包`)
      }
      return { content: [{ type: 'text', text: parts.join('\n') }], isError: false }
    }

    // ── 进程管理 ──
    case 'list_processes': {
      const sort = args.sort === 'cpu' ? '-%cpu' : args.sort === 'pid' ? 'pid' : '-%mem'
      const tree = args.tree ? 'pstree 2>/dev/null || ' : ''
      const count = args.count || 30
      const filter = args.filter ? ` | grep -i "${args.filter}"` : ''
      const cmd = args.tree
        ? `${tree}ps aux --sort=${sort}${filter} | head -${count}`
        : `ps aux --sort=${sort}${filter} | head -${count}`
      const result = safeExec(cmd)
      return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
    }

    case 'kill_process': {
      let result
      if (args.pid) {
        result = safeExec(`kill -${args.signal || 'TERM'} ${args.pid} 2>&1`)
      } else if (args.name) {
        result = safeExec(`killall -${args.signal || 'TERM'} "${args.name}" 2>&1`)
      } else {
        return { content: [{ type: 'text', text: 'Provide pid or name' }], isError: true }
      }
      return { content: [{ type: 'text', text: result.stdout || 'Signal sent' }], isError: !!result.stderr }
    }

    // ── PM2 ──
    case 'pm2_status': {
      const result = safeExec('pm2 list')
      return { content: [{ type: 'text', text: result.stdout || '(pm2 not found)' }], isError: !!result.stderr }
    }

    case 'pm2_operate': {
      const { action, name: pname, lines } = args
      if (action === 'logs') {
        const result = safeExec(`pm2 logs ${pname} --lines ${lines || 30} --nostream`)
        return { content: [{ type: 'text', text: result.stdout || '(no logs)' }], isError: !!result.stderr }
      }
      if (action === 'monit') {
        const result = safeExec(`pm2 monit 2>&1; echo "---"; pm2 show ${pname}`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      const result = safeExec(`pm2 ${action} ${pname}`)
      return { content: [{ type: 'text', text: result.stdout || `${action} ${pname} done` }], isError: !!result.stderr }
    }

    case 'pm2_start': {
      const envFlag = args.env ? `--env ${args.env}` : ''
      const cwdFlag = args.cwd ? `--cwd ${args.cwd}` : ''
      const nameFlag = args.name ? `--name ${args.name}` : ''
      const result = safeExec(`pm2 start ${args.path} ${nameFlag} ${cwdFlag} ${envFlag} ${args.args || ''}`)
      return { content: [{ type: 'text', text: result.stdout || 'started' }], isError: !!result.stderr }
    }

    // ── Nginx ──
    case 'nginx_status': {
      const { action: naction } = args
      if (naction === 'test') {
        const result = safeExec('nginx -t 2>&1')
        return { content: [{ type: 'text', text: result.stdout || result.stderr || 'OK' }], isError: !!result.stderr }
      }
      if (naction === 'status') {
        const result = safeExec('systemctl status nginx --no-pager | head -25')
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (naction === 'reload' || naction === 'restart' || naction === 'start' || naction === 'stop') {
        const result = safeExec(`systemctl ${naction} nginx 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || `nginx ${naction} done` }], isError: !!result.stderr }
      }
      if (naction === 'sites') {
        const enabled = safeExec('ls /etc/nginx/conf.d/ 2>/dev/null || ls /etc/nginx/sites-enabled/ 2>/dev/null')
        const available = safeExec('ls /etc/nginx/sites-available/ 2>/dev/null || echo "(same as conf.d)"')
        return { content: [{ type: 'text', text: `Enabled:\n${enabled.stdout}\n\nAvailable:\n${available.stdout}` }], isError: false }
      }
      return { content: [{ type: 'text', text: `Unknown action: ${naction}` }], isError: true }
    }

    case 'nginx_edit_site': {
      const { name: sname, action: saction, content, domain, proxy_pass } = args
      const confDir = '/etc/nginx/conf.d'
      const sitesAvail = '/etc/nginx/sites-available'
      const sitesEnabled = '/etc/nginx/sites-enabled'
      const confDirExists = fs.existsSync(confDir)
      const sitesAvailExists = fs.existsSync(sitesAvail)

      if (saction === 'list') {
        const result = safeExec(`ls ${confDir} 2>/dev/null; ls ${sitesAvail} 2>/dev/null`)
        return { content: [{ type: 'text', text: result.stdout || '(no sites)' }], isError: false }
      }
      if (saction === 'read') {
        const paths = [path.join(confDir, sname), path.join(sitesAvail, sname), path.join(sitesEnabled, sname)]
        for (const p of paths) {
          if (fs.existsSync(p)) {
            const data = fs.readFileSync(p, 'utf-8')
            return { content: [{ type: 'text', text: `# ${p}\n${data}` }], isError: false }
          }
        }
        return { content: [{ type: 'text', text: `Site config not found: ${sname}` }], isError: true }
      }
      if (saction === 'enable') {
        const result = safeExec(`ln -sf ${sitesAvail}/${sname} ${sitesEnabled}/${sname} 2>&1 && nginx -t 2>&1 && nginx -s reload 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || 'enabled' }], isError: !!result.stderr }
      }
      if (saction === 'disable') {
        const result = safeExec(`rm -f ${sitesEnabled}/${sname} 2>&1 && nginx -s reload 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || 'disabled' }], isError: !!result.stderr }
      }
      if (saction === 'create') {
        if (!domain) return { content: [{ type: 'text', text: 'domain required' }], isError: true }
        const cfg = content || `server {
    listen 80;
    server_name ${domain};
    location / {
        ${proxy_pass ? `proxy_pass ${proxy_pass};` : 'root /var/www/html;'}
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`
        const target = confDirExists ? confDir : sitesAvail
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, sname), cfg, 'utf-8')
        safeExec('nginx -t 2>&1')
        return { content: [{ type: 'text', text: `Created ${target}/${sname}\nRun "nginx_edit_site action=enable" to activate` }], isError: false }
      }
      return { content: [{ type: 'text', text: `Unknown action: ${saction}` }], isError: true }
    }

    // ── Docker ──
    case 'docker_ps': {
      const all = args.all ? '-a' : ''
      const filter = args.filter ? `--filter "${args.filter}"` : ''
      const result = safeExec(`docker ps ${all} ${filter} 2>&1`)
      return { content: [{ type: 'text', text: result.stdout || '(no containers)' }], isError: !!result.stderr }
    }

    case 'docker_images': {
      const result = safeExec('docker images 2>&1')
      return { content: [{ type: 'text', text: result.stdout || '(no images)' }], isError: !!result.stderr }
    }

    case 'docker_operate': {
      const { container, action: dAction, command, lines } = args
      if (dAction === 'logs') {
        const result = safeExec(`docker logs --tail ${lines || 50} ${container} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (dAction === 'stats') {
        const result = safeExec(`docker stats ${container} --no-stream 2>&1`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (dAction === 'exec') {
        const result = safeExec(`docker exec ${container} ${command} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      const result = safeExec(`docker ${dAction} ${container} 2>&1`)
      return { content: [{ type: 'text', text: result.stdout || `${dAction} ${container} done` }], isError: !!result.stderr }
    }

    case 'docker_compose': {
      const { path: dcPath, action: dcAction, service } = args
      const svc = service || ''
      const result = safeExec(`cd "${dcPath}" && docker-compose ${dcAction} ${svc} 2>&1`)
      return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
    }

    // ── 包管理 ──
    case 'package_list': {
      const { type: ptype, name: pname } = args
      if (ptype === 'installed') {
        const result = safeExec('rpm -qa --qf "%{NAME}-%{VERSION}.%{RELEASE}\n" 2>/dev/null | sort | head -100 || dpkg -l 2>/dev/null | head -100')
        return { content: [{ type: 'text', text: result.stdout || '(check failed)' }], isError: !!result.stderr }
      }
      if (ptype === 'available_updates') {
        const result = safeExec('yum check-update -q 2>/dev/null | head -50 || dnf check-update -q 2>/dev/null | head -50 || apt list --upgradable 2>/dev/null | head -50')
        return { content: [{ type: 'text', text: result.stdout || '(up to date)' }], isError: !!result.stderr }
      }
      if (ptype === 'search') {
        const result = safeExec(`yum search "${pname}" 2>/dev/null | head -30 || dnf search "${pname}" 2>/dev/null | head -30 || apt search "${pname}" 2>/dev/null | head -30`)
        return { content: [{ type: 'text', text: result.stdout || '(not found)' }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: 'Invalid type' }], isError: true }
    }

    case 'package_install': {
      const { name: iname, action: iaction } = args
      if (iaction === 'install') {
        const result = safeExec(`yum install -y ${iname} 2>&1 | tail -10 || dnf install -y ${iname} 2>&1 | tail -10 || apt-get install -y ${iname} 2>&1 | tail -10`)
        return { content: [{ type: 'text', text: result.stdout || `Installed ${iname}` }], isError: !!result.stderr }
      }
      if (iaction === 'remove') {
        const result = safeExec(`yum remove -y ${iname} 2>&1 | tail -10 || dnf remove -y ${iname} 2>&1 | tail -10 || apt-get remove -y ${iname} 2>&1 | tail -10`)
        return { content: [{ type: 'text', text: result.stdout || `Removed ${iname}` }], isError: !!result.stderr }
      }
      const result = safeExec('yum update -y 2>&1 | tail -5 || dnf update -y 2>&1 | tail -5 || apt-get upgrade -y 2>&1 | tail -5')
      return { content: [{ type: 'text', text: result.stdout || 'Updated' }], isError: !!result.stderr }
    }

    case 'npm_manage': {
      const { cwd: npmCwd, action: npmAction, package: npmPkg, script: npmScript } = args
      if (npmAction === 'list') {
        const result = safeExec('npm ls --depth=0 2>&1', npmCwd)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (npmAction === 'install') {
        const result = safeExec(`npm install ${npmPkg || ''} 2>&1 | tail -10`, npmCwd)
        return { content: [{ type: 'text', text: result.stdout || 'Installed' }], isError: !!result.stderr }
      }
      if (npmAction === 'update') {
        const result = safeExec(`npm update ${npmPkg || ''} 2>&1 | tail -10`, npmCwd)
        return { content: [{ type: 'text', text: result.stdout || 'Updated' }], isError: !!result.stderr }
      }
      if (npmAction === 'run' || npmAction === 'test' || npmAction === 'build') {
        const scriptName = npmScript || npmAction
        const result = safeExec(`npm run ${scriptName} 2>&1 | tail -20`, npmCwd)
        return { content: [{ type: 'text', text: result.stdout || '(done)' }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: `Unknown npm action: ${npmAction}` }], isError: true }
    }

    // ── 网络工具 ──
    case 'network_check': {
      const { target, type: ntype, port, timeout } = args
      const to = timeout || 10
      if (ntype === 'ping') {
        const result = safeExec(`ping -c 4 -W ${to} ${target} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || result.stderr }], isError: !!result.stderr }
      }
      if (ntype === 'curl') {
        const result = safeExec(`curl -sI --connect-timeout ${to} "${target}" 2>&1 | head -20`)
        return { content: [{ type: 'text', text: result.stdout || result.stderr }], isError: !!result.stderr }
      }
      if (ntype === 'port') {
        const result = safeExec(`timeout ${to} bash -c "echo >/dev/tcp/${target}/${port}" 2>&1 && echo "Port ${port} OPEN" || echo "Port ${port} CLOSED"`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (ntype === 'dns') {
        const result = safeExec(`nslookup ${target} 2>&1 || dig ${target} 2>&1 | head -15`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (ntype === 'traceroute') {
        const result = safeExec(`traceroute -m 15 -w 2 ${target} 2>&1 || tracert ${target} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: 'Invalid type' }], isError: true }
    }

    case 'ssl_check': {
      const result = safeExec(`echo | openssl s_client -servername ${args.domain} -connect ${args.domain}:${args.port || 443} 2>/dev/null | openssl x509 -noout -dates -subject -issuer 2>/dev/null`)
      if (!result.stdout) {
        return { content: [{ type: 'text', text: `Could not retrieve SSL cert for ${args.domain}` }], isError: true }
      }
      return { content: [{ type: 'text', text: `📜 SSL 证书: ${args.domain}:${args.port || 443}\n${'-'.repeat(50)}\n${result.stdout}` }], isError: false }
    }

    case 'firewall_status': {
      const { action: fwAction, port: fwPort, service: fwService, zone } = args
      const zn = zone || 'public'
      if (fwAction === 'status') {
        const result = safeExec('firewall-cmd --state 2>&1; echo "---"; firewall-cmd --list-all 2>&1 || iptables -L -n --line-numbers 2>&1 | head -30')
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (fwAction === 'list') {
        const result = safeExec(`firewall-cmd --zone=${zn} --list-all 2>&1 || iptables -L -n --line-numbers 2>&1`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (fwAction === 'add_port') {
        const result = safeExec(`firewall-cmd --zone=${zn} --add-port=${fwPort} --permanent && firewall-cmd --reload 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || `Port ${fwPort} added` }], isError: !!result.stderr }
      }
      if (fwAction === 'remove_port') {
        const result = safeExec(`firewall-cmd --zone=${zn} --remove-port=${fwPort} --permanent && firewall-cmd --reload 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || `Port ${fwPort} removed` }], isError: !!result.stderr }
      }
      if (fwAction === 'add_service') {
        const result = safeExec(`firewall-cmd --zone=${zn} --add-service=${fwService} --permanent && firewall-cmd --reload 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || `Service ${fwService} added` }], isError: !!result.stderr }
      }
      if (fwAction === 'reload') {
        const result = safeExec('firewall-cmd --reload 2>&1')
        return { content: [{ type: 'text', text: result.stdout || 'reloaded' }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: `Unknown action: ${fwAction}` }], isError: true }
    }

    case 'cron_manage': {
      const { action: cAction, line, user, index } = args
      const cronUser = user || 'root'
      if (cAction === 'list') {
        const result = safeExec(`crontab -u ${cronUser} -l 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || '(no crontab)' }], isError: !!result.stderr }
      }
      if (cAction === 'add') {
        const current = safeExec(`crontab -u ${cronUser} -l 2>/dev/null || true`).stdout
        const newCron = `${current}\n${line}\n`
        fs.writeFileSync('/tmp/mcp_crontab', newCron, 'utf-8')
        const result = safeExec(`crontab -u ${cronUser} /tmp/mcp_crontab 2>&1`)
        try { fs.unlinkSync('/tmp/mcp_crontab') } catch {}
        return { content: [{ type: 'text', text: result.stdout || 'Cron added' }], isError: !!result.stderr }
      }
      if (cAction === 'remove') {
        const lines = safeExec(`crontab -u ${cronUser} -l 2>/dev/null || true`).stdout.split('\n')
        const idx = index !== undefined ? index - 1 : lines.length - 1
        lines.splice(idx, 1)
        fs.writeFileSync('/tmp/mcp_crontab', lines.join('\n').trim() + '\n', 'utf-8')
        const result = safeExec(`crontab -u ${cronUser} /tmp/mcp_crontab 2>&1`)
        try { fs.unlinkSync('/tmp/mcp_crontab') } catch {}
        return { content: [{ type: 'text', text: result.stdout || 'Cron removed' }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: `Unknown action: ${cAction}` }], isError: true }
    }

    // ── SSL ──
    case 'certbot_manage': {
      const { action: certAction, domain, email } = args
      if (certAction === 'list') {
        const result = safeExec('certbot certificates 2>&1')
        return { content: [{ type: 'text', text: result.stdout || '(certbot not found)' }], isError: !!result.stderr }
      }
      if (certAction === 'renew') {
        const result = safeExec('certbot renew 2>&1')
        return { content: [{ type: 'text', text: result.stdout || 'Renewed' }], isError: !!result.stderr }
      }
      if (certAction === 'certonly') {
        const result = safeExec(`certbot certonly --standalone -d ${domain} --non-interactive --agree-tos -m ${email} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: `Unknown action: ${certAction}` }], isError: true }
    }

    // ── Git ──
    case 'git_manage': {
      const { cwd: gitCwd, action: gitAction, url, branch, depth, count, path: gitPath } = args
      if (gitAction === 'clone') {
        const branchFlag = branch ? `-b ${branch}` : ''
        const depthFlag = depth ? `--depth ${depth}` : ''
        const result = safeExec(`git clone ${branchFlag} ${depthFlag} ${url} ${gitPath || ''} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || 'Cloned' }], isError: !!result.stderr }
      }
      const cmds = {
        status: 'git status 2>&1',
        pull: `git pull ${branch ? `origin ${branch}` : ''} 2>&1`,
        log: `git log --oneline -${count || 10} 2>&1`,
        branch: 'git branch -a 2>&1',
        checkout: `git checkout ${branch} 2>&1`,
        diff: 'git diff --stat 2>&1',
        reset: `git reset --hard ${branch || 'HEAD'} 2>&1`,
      }
      const cmd = cmds[gitAction]
      if (!cmd) return { content: [{ type: 'text', text: `Unknown git action: ${gitAction}` }], isError: true }
      const result = safeExec(cmd, gitCwd)
      return { content: [{ type: 'text', text: result.stdout || result.stderr }], isError: !!result.stderr }
    }

    // ── 备份/压缩 ──
    case 'archive_manage': {
      const { action: arcAction, source, dest, format } = args
      if (arcAction === 'compress') {
        const fmt = format || 'tar.gz'
        if (fmt === 'zip') {
          const result = safeExec(`zip -r "${dest || source + '.zip'}" "${source}" 2>&1`)
          return { content: [{ type: 'text', text: result.stdout || 'Compressed' }], isError: !!result.stderr }
        }
        const result = safeExec(`tar -czf "${dest || source + '.tar.gz'}" "${source}" 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || 'Compressed' }], isError: !!result.stderr }
      }
      if (arcAction === 'extract') {
        const ext = source.match(/\.(tar\.gz|tgz|tar\.bz2|zip)$/)?.[1]
        const destDir = dest || path.dirname(source)
        if (ext === 'zip') {
          const result = safeExec(`unzip -o "${source}" -d "${destDir}" 2>&1 | tail -10`)
          return { content: [{ type: 'text', text: result.stdout || 'Extracted' }], isError: !!result.stderr }
        }
        const result = safeExec(`tar -xzf "${source}" -C "${destDir}" 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || 'Extracted' }], isError: !!result.stderr }
      }
      if (arcAction === 'list') {
        const ext = source.match(/\.(tar\.gz|tgz|zip)$/)?.[1]
        if (ext === 'zip') {
          const result = safeExec(`unzip -l "${source}" 2>&1 | head -50`)
          return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
        }
        const result = safeExec(`tar -tzf "${source}" 2>&1 | head -50`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: `Unknown action: ${arcAction}` }], isError: true }
    }

    case 'rsync_manage': {
      const { source: rsSrc, dest: rsDst, options, remote_host, direction } = args
      const opts = options || '-avz'
      if (direction === 'pull') {
        const result = safeExec(`rsync ${opts} ${remote_host ? `${remote_host}:${rsSrc}` : rsSrc} ${rsDst} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || 'Sync done' }], isError: !!result.stderr }
      }
      const result = safeExec(`rsync ${opts} ${rsSrc} ${remote_host ? `${remote_host}:${rsDst}` : rsDst} 2>&1`)
      return { content: [{ type: 'text', text: result.stdout || 'Sync done' }], isError: !!result.stderr }
    }

    // ── 用户管理 ──
    case 'user_manage': {
      const { action: uAction, username, password, group, shell, home } = args
      if (uAction === 'list') {
        const result = safeExec('cat /etc/passwd | cut -d: -f1,3,6,7 | head -40')
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (uAction === 'info') {
        const result = safeExec(`id ${username} 2>&1; echo "---"; chage -l ${username} 2>&1 || true`)
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      if (uAction === 'create') {
        const homeDir = home || `/home/${username}`
        const userShell = shell || '/bin/bash'
        const result = safeExec(`useradd -m -d ${homeDir} -s ${userShell} ${group ? `-g ${group}` : ''} ${username} 2>&1 && echo "${password}" | passwd --stdin ${username} 2>&1`)
        return { content: [{ type: 'text', text: result.stdout || `User ${username} created` }], isError: !!result.stderr }
      }
      if (uAction === 'groups') {
        const result = safeExec('cat /etc/group | cut -d: -f1 | sort | head -40')
        return { content: [{ type: 'text', text: result.stdout }], isError: !!result.stderr }
      }
      return { content: [{ type: 'text', text: `Unknown action: ${uAction}` }], isError: true }
    }

    // ── 诊断 ──
    case 'diagnose': {
      const focus = args.focus || 'all'
      const parts = [`🔍 快速诊断 (focus: ${focus})\n${'='.repeat(40)}`]

      if (focus === 'all' || focus === 'performance') {
        parts.push(`\n📊 负载: ${safeExec('uptime').stdout.trim()}`)
        parts.push(`内存: ${safeExec('free -h | grep Mem').stdout.trim()}`)
        parts.push(`Swap: ${safeExec('free -h | grep Swap').stdout.trim()}`)
        parts.push(`CPU 高占用: \n${safeExec('ps aux --sort=-%cpu | head -6').stdout}`)
        parts.push(`内存高占用: \n${safeExec('ps aux --sort=-%mem | head -6').stdout}`)
        parts.push(`磁盘 I/O: \n${safeExec('iostat -x 1 1 2>/dev/null || echo "(not available)"').stdout.trim()}`)
      }

      if (focus === 'all' || focus === 'network') {
        parts.push(`\n🌐 网络连接: ${safeExec('ss -s 2>/dev/null | head -5').stdout}`)
        parts.push(`监听端口:\n${safeExec('ss -tlnp 2>/dev/null | head -15').stdout}`)
        parts.push(`公网 IP: ${safeExec('curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || echo "(timeout)"').stdout.trim()}`)
      }

      if (focus === 'all' || focus === 'storage') {
        parts.push(`\n💾 磁盘使用:\n${safeExec('df -h | grep -v tmpfs | grep -v devtmpfs').stdout}`)
        const topDirs = safeExec('du -sh /* 2>/dev/null | sort -rh | head -10').stdout
        if (topDirs) parts.push(`最大目录:\n${topDirs}`)
      }

      if (focus === 'all' || focus === 'security') {
        parts.push(`\n🔐 失败登录: ${safeExec('lastb 2>/dev/null | head -3 || echo "(none)"').stdout.trim()}`)
        parts.push(`最近登录: ${safeExec('last -5 2>/dev/null').stdout.trim()}`)
        parts.push(`SELinux: ${safeExec('getenforce 2>/dev/null || echo "N/A"').stdout.trim()}`)
      }

      return { content: [{ type: 'text', text: parts.join('\n') }], isError: false }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
}

// ─── HTTP 服务器 ───

function parseBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // SSE
  if (req.url === '/sse' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
    res.write('data: {"jsonrpc":"2.0","method":"server/connected"}\n\n')
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000)
    req.on('close', () => clearInterval(keepAlive))
    return
  }

  // MCP
  if (req.method === 'POST' && ['/', '/message', '/mcp'].includes(req.url)) {
    if (AUTH_TOKEN) {
      const auth = req.headers['authorization']
      if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }))
        return
      }
    }

    const body = await parseBody(req)
    let msg
    try { msg = JSON.parse(body) } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(createError(null, -32700, 'Parse error'))
      return
    }

    const id = msg.id || ++requestId

    if (msg.method === 'initialize') {
      res.end(createResponse(id, { protocolVersion: '0.1.0', serverInfo: { name: 'akemi-mio-remote', version: '2.0.0' }, capabilities: { tools: {} } }))
    } else if (msg.method === 'tools/list') {
      res.end(createResponse(id, { tools: TOOLS }))
    } else if (msg.method === 'tools/call') {
      const { name: tname, arguments: targs } = msg.params || {}
      if (!tname) { res.end(createError(id, -32602, 'Missing tool name')); return }
      try {
        const result = await handleToolCall(tname, targs || {})
        res.end(createResponse(id, result))
      } catch (e) {
        res.end(createResponse(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }))
      }
    } else if (msg.method === 'ping') {
      res.end(createResponse(id, {}))
    } else if (msg.method === 'shutdown') {
      res.end(createResponse(id, {}))
      setTimeout(() => process.exit(0), 100)
    } else {
      res.end(createError(id, -32601, `Method not found: ${msg.method}`))
    }
    return
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', server: 'akemi-mio-remote', tools: TOOLS.length }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[MCP Server v2] running on http://0.0.0.0:${PORT}`)
  console.log(`[MCP Server] tools: ${TOOLS.map(t => t.name).join(', ')}`)
})
