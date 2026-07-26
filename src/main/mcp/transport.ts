import { ChildProcess } from 'child_process'
import { request as httpsRequest, RequestOptions } from 'https'
import { request as httpRequest } from 'http'
import { MCPResponse, MCPRequest } from './types'

export interface Transport {
  send(message: string): Promise<void>
  onMessage(handler: (data: MCPResponse) => void): void
  close(): Promise<void>
}

/**
 * StdioTransport — 通过 stdio 与子进程通信的 MCP 传输层。
 *
 * 要求必须传入已启动的 ChildProcess（由 ProcessManager 提供），
 * 不自行 spawn。测试场景应 mock Transport 接口而非绕过此约束。
 *
 * 构造函数参数保留 command/args/env/cwd 仅用于日志标识，
 * 不用于 spawn。
 *
 * C-6：所有托管进程必须经过 ProcessManager。
 */
export class StdioTransport implements Transport {
  private process: ChildProcess
  private buffer = ''
  private handler: ((data: MCPResponse) => void) | null = null
  private lineHandler: ((line: string) => void) | null = null

  constructor(
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
    cwd?: string,
    existingProcess: ChildProcess | null = null,
  ) {
    if (!existingProcess) {
      throw new Error(
        `StdioTransport requires an existing ChildProcess (C-6). ` +
        `Use ProcessManager.registerSpawn() to create one. ` +
        `Command attempted: ${command} ${args.join(' ')}`,
      )
    }
    this.process = existingProcess

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const data = JSON.parse(trimmed) as MCPResponse
          this.handler?.(data)
          this.lineHandler?.(trimmed)
        } catch {
          // skip incomplete lines
        }
      }
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.error(`[MCP:stdio] ${text}`)
    })

    this.process.on('exit', (code) => {
      console.error(`[MCP:stdio] process exited with code ${code}`)
    })
  }

  async send(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process.stdin?.writable) {
        reject(new Error('stdin not writable'))
        return
      }
      this.process.stdin.write(message + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  onMessage(handler: (data: MCPResponse) => void): void {
    this.handler = handler
  }

  onRawLine(handler: (line: string) => void): void {
    this.lineHandler = handler
  }

  async close(): Promise<void> {
    if (!this.process.killed) {
      this.process.kill()
    }
  }
}

/**
 * HttpTransport — 通过 HTTP/SSE 连接远程 MCP 服务器
 *
 * 遵循 MCP HTTP 传输规范：
 * - 请求通过 POST 发送到 endpoint
 * - 响应通过 SSE (text/event-stream) 接收
 */
export class HttpTransport implements Transport {
  private url: string
  private requestTimeoutMs: number
  private headers: Record<string, string>
  private handler: ((data: MCPResponse) => void) | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private abortController = new AbortController()
  private closed = false
  private connected = false

  constructor(url: string, requestTimeoutMs = 30000, headers: Record<string, string> = {}) {
    // 标准化 URL，移除尾部 /
    this.url = url.replace(/\/+$/, '')
    this.requestTimeoutMs = requestTimeoutMs
    this.headers = headers
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error('Transport closed')

    const isSSE = this.url.endsWith('/sse')

    let url: string
    if (isSSE) {
      // SSE endpoint 使用 POST 到 message endpoint
      url = this.url.replace(/\/sse$/, '/message')
    } else {
      url = this.url
    }

    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'

    const requestFn = isHttps ? httpsRequest : httpRequest

    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(message, 'utf-8'),
          ...this.headers,
        },
        signal: this.abortController.signal,
        timeout: this.requestTimeoutMs,
      }

      const req = requestFn(options, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const data = JSON.parse(body) as MCPResponse
              this.handler?.(data)
            } catch {
              // 非 JSON 响应可能是 SSE 或心跳
              if (body.startsWith('data: ')) {
                this.parseSSELine(body)
              }
            }
            resolve()
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      req.write(message)
      req.end()
    })
  }

  /** 启动 SSE 连接监听（仅用于长期订阅的 SSE 端点） */
  async connectSSE(): Promise<void> {
    if (this.connected) return
    if (!this.url.endsWith('/sse')) {
      // 非 SSE 模式不需要长期连接
      this.connected = true
      return
    }

    const parsed = new URL(this.url)
    const isHttps = parsed.protocol === 'https:'
    const requestFn = isHttps ? httpsRequest : httpRequest

    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...this.headers,
        },
        signal: this.abortController.signal,
        timeout: this.requestTimeoutMs,
      }

      const req = requestFn(options, (res) => {
        if (!res.statusCode || res.statusCode >= 300) {
          reject(new Error(`SSE connection failed: HTTP ${res.statusCode}`))
          return
        }

        this.connected = true
        resolve()

        let buffer = ''
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            this.parseSSELine(line)
          }
        })

        res.on('end', () => {
          if (buffer.trim()) this.parseSSELine(buffer.trim())
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('SSE connection timeout'))
      })
      req.end()
    })
  }

  private parseSSELine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) return

    // SSE data: 前缀处理
    const dataPrefix = 'data: '
    if (trimmed.startsWith(dataPrefix)) {
      const jsonStr = trimmed.slice(dataPrefix.length).trim()
      try {
        const data = JSON.parse(jsonStr) as MCPResponse
        this.handler?.(data)
      } catch {
        // 忽略非 JSON SSE 事件
      }
    }
  }

  onMessage(handler: (data: MCPResponse) => void): void {
    this.handler = handler
  }

  async close(): Promise<void> {
    this.closed = true
    this.abortController.abort()
    this.connected = false
    this.handler = null
  }
}
