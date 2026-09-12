import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspaceRoot = process.cwd()
const appRuntimePath = join(workspaceRoot, 'packages', 'main', 'src', 'bootstrap', 'AppRuntime.ts')
const fanqieMcpPath = join(workspaceRoot, 'extensions', 'fanqie-mcp', 'fanqie-mcp.mjs')

function waitForJsonLine(child: ReturnType<typeof spawn>, id: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = ''
    let stderrBuffer = ''

    const onStdout = (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = JSON.parse(trimmed)
        if (parsed.id === id) {
          cleanup()
          resolve(parsed)
          return
        }
      }
    }

    const onStderr = (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString()
    }

    const onExit = () => {
      cleanup()
      reject(new Error(`fanqie MCP exited before responding. stderr: ${stderrBuffer}`))
    }

    const cleanup = () => {
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.on('exit', onExit)
  })
}

describe('Fanqie provider contract', () => {
  it('wires FANQIE_AUTHOR_URL through AppRuntime fanqie MCP startup', () => {
    const source = readFileSync(appRuntimePath, 'utf8')

    expect(source).toContain('fanqie_author_url')
    expect(source).toContain('FANQIE_AUTHOR_URL')
    expect(source).toContain("tool: 'fanqie_publish_novel'")
  })

  it('fanqie MCP auth probe surfaces configured author url when CDP is unavailable', async () => {
    const child = spawn(process.execPath, [fanqieMcpPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CDP_PORT: '65530',
        FANQIE_AUTHOR_URL: 'https://writer.example.com/workbench',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        })}\n`,
      )
      await waitForJsonLine(child, 1)

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        })}\n`,
      )

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'fanqie_auth_inspect',
            arguments: {},
          },
        })}\n`,
      )

      const response = await waitForJsonLine(child, 2)
      const payload = JSON.parse(response.result.content[0].text)

      expect(payload.loggedIn).toBe(false)
      expect(payload.error).toContain('https://writer.example.com/workbench')
    } finally {
      child.kill()
    }
  })
})
