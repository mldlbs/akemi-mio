import { readFileSync } from 'fs'
import { Client } from 'ssh2'
import { getCredentialsManager } from '../deps'

interface SSHConfig {
  host: string
  port: number
  username: string
}

const CONNECTION_TIMEOUT = 15_000
const EXEC_TIMEOUT = 60_000

function getDefaultSSHConfig(): SSHConfig {
  const cm = getCredentialsManager()
  return {
    host: cm?.get('centos_host') || 'localhost',
    port: parseInt(cm?.get('centos_port') || '22', 10),
    username: cm?.get('centos_user') || 'root',
  }
}

function getSSHAuth(): { password?: string; privateKey?: string | Buffer } {
  const cm = getCredentialsManager()
  const key = cm?.get('centos_ssh_key')
  if (key) {
    return { privateKey: key.includes('\n') ? key : readFileSync(key, 'utf-8') }
  }
  const pwd = cm?.get('centos_password')
  if (pwd) return { password: pwd }
  return {}
}

function connectSSH(host: string, port: number, username: string, auth: Record<string, any>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error(`SSH 连接超时 (${host}:${port}, ${CONNECTION_TIMEOUT}ms)`))
    }, CONNECTION_TIMEOUT)

    client.on('ready', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    client.connect({
      host,
      port,
      username,
      readyTimeout: CONNECTION_TIMEOUT,
      hostHash: 'sha256',
      hostVerifier: () => true,
      ...auth,
    })
  })
}

function execCommand(client: Client, command: string, timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const execTimeout = timeout ?? EXEC_TIMEOUT
    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      client.end()
      reject(new Error(`SSH 命令执行超时 (${execTimeout}ms): ${command.slice(0, 100)}`))
    }, execTimeout)

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return reject(err)
      }
      stream.setEncoding('utf-8')
      stream.on('data', (data: string) => {
        stdout += data
      })
      stream.stderr.on('data', (data: string) => {
        stderr += data
      })
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code !== 0 && code !== null) {
          const msg = stderr.trim() || `exit code ${code}`
          reject(new Error(`命令执行失败 (${code}): ${msg.slice(0, 500)}`))
        } else {
          resolve(stdout.trim())
        }
      })
    })
  })
}

/** SSH 执行远程命令 */
export async function sshExec(host?: string, command?: string, timeout?: number): Promise<string> {
  if (!command) throw new Error('command 参数缺失')
  const cfg = host ? { host, port: 22, username: 'root' } : getDefaultSSHConfig()
  const auth = getSSHAuth()
  const client = await connectSSH(cfg.host, cfg.port, cfg.username, auth)
  try {
    return await execCommand(client, command, timeout)
  } finally {
    client.end()
  }
}

/** SSH 读取远程文件内容 */
export async function sshReadFile(remotePath: string): Promise<string> {
  if (!remotePath) throw new Error('path 参数缺失')
  const cfg = getDefaultSSHConfig()
  const auth = getSSHAuth()
  const client = await connectSSH(cfg.host, cfg.port, cfg.username, auth)
  try {
    return await new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(new Error(`SFTP 连接失败: ${err.message}`))
        sftp.readFile(remotePath, (err2, data) => {
          sftp.end()
          if (err2) return reject(new Error(`远程读取文件失败: ${err2.message}`))
          resolve(data.toString('utf-8'))
        })
      })
    })
  } finally {
    client.end()
  }
}

/** SSH 写入远程文件 */
export async function sshWriteFile(remotePath: string, content: string): Promise<void> {
  if (!remotePath) throw new Error('path 参数缺失')
  if (content === undefined || content === null) throw new Error('content 参数缺失')
  const cfg = getDefaultSSHConfig()
  const auth = getSSHAuth()
  const client = await connectSSH(cfg.host, cfg.port, cfg.username, auth)
  try {
    await new Promise<void>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(new Error(`SFTP 连接失败: ${err.message}`))
        sftp.writeFile(remotePath, Buffer.from(content, 'utf-8'), (err2) => {
          sftp.end()
          if (err2) return reject(new Error(`远程写入文件失败: ${err2.message}`))
          resolve()
        })
      })
    })
  } finally {
    client.end()
  }
}

/** SSH grep 远程文件内容 */
export async function sshGrep(pattern: string, path?: string): Promise<string> {
  if (!pattern) throw new Error('pattern 参数缺失')
  const targetPath = path || '.'
  const escaped = pattern.replace(/'/g, "'\\''")
  const cmd = `grep -rn '${escaped}' ${targetPath} 2>/dev/null | head -200`
  return await sshExec(undefined, cmd)
}

/** SSH glob 搜索远程文件 */
export async function sshSearchFiles(pattern: string): Promise<string> {
  if (!pattern) throw new Error('pattern 参数缺失')
  const cmd = `find . -name '${pattern.replace(/'/g, "'\\''")}' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -200`
  return await sshExec(undefined, cmd)
}
