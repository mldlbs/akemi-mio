import { execFileSync } from 'child_process'
import { log } from './logger'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

// D7: the collectors used bare `fetch()`, which never reads the proxy a
// Windows box has actually configured (WinINET's ProxyServer lives in the
// registry, and Node's fetch ignores it -- unlike a browser, which is how the
// issue could say "the browser opens github.com, the collector times out").
// Result: with a system proxy on and no direct route, every external source
// failed while the same URL worked everywhere else.
//
// Two rules keep this from changing behaviour for anyone who is not proxied:
//   * no proxy resolved  -> plain global fetch, byte-for-byte the old path;
//   * a proxy resolved    -> undici + ProxyAgent, and if the proxy itself is
//     unreachable (stale ProxyEnable with the client closed) we fall back to
//     direct instead of turning a working direct route into a failure.

export interface SystemProxy {
  /** ProxyServer, split by scheme. `default` covers the "one server for all" form. */
  servers: { http?: string; https?: string; default?: string }
  /** ProxyOverride entries: `*.x.com`, `127.*`, `<local>`, bare hostnames. */
  bypass: string[]
}

export interface ProxyOptions {
  /** Injectable so tests never depend on this machine's env (default: process.env). */
  env?: Record<string, string | undefined>
  /** Injectable Windows proxy reader (default: cached WinINET registry read). */
  readSystemProxy?: () => SystemProxy | null
}

const SYSTEM_PROXY_TTL_MS = 30_000
let systemProxyCache: { at: number; value: SystemProxy | null } | null = null

/** Drops the cached WinINET read. Exported for tests and for long-lived hosts. */
export function resetSystemProxyCache(): void {
  systemProxyCache = null
}

function envValue(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value && value.trim()) return value
  }
  return undefined
}

/**
 * Windows system proxy from HKCU Internet Settings. Cached for 30s because a
 * `reg query` per request would cost more than the fetch itself.
 * Returns null off Windows, when the key is missing, or when ProxyEnable=0.
 */
export function readWindowsSystemProxy(): SystemProxy | null {
  const now = Date.now()
  if (systemProxyCache && now - systemProxyCache.at < SYSTEM_PROXY_TTL_MS) return systemProxyCache.value
  const value = process.platform === 'win32' ? readWininetSettings() : null
  systemProxyCache = { at: now, value }
  return value
}

function readWininetSettings(): SystemProxy | null {
  let out = ''
  try {
    out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch {
    return null
  }
  const values: Record<string, string> = {}
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\w+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (m) values[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
  if (!values.ProxyEnable || !/^0*1$/.test(values.ProxyEnable.replace(/^0x/i, ''))) return null
  if (!values.ProxyServer) return null
  return {
    servers: parseProxyServer(values.ProxyServer),
    bypass: parseBypassList(values.ProxyOverride, /[;]/),
  }
}

/** `127.0.0.1:7890` or `http=127.0.0.1:7890;https=127.0.0.1:7890`. */
export function parseProxyServer(value: string): SystemProxy['servers'] {
  const servers: SystemProxy['servers'] = {}
  for (const part of String(value).split(';')) {
    const entry = part.trim()
    if (!entry) continue
    const eq = entry.indexOf('=')
    const key = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : null
    const val = eq > 0 ? entry.slice(eq + 1).trim() : entry
    if (key === 'http' || key === 'https') {
      servers[key] = val
    } else if (key === 'socks' || key === 'socks5') {
      // ProxyAgent speaks HTTP(S) proxies; a socks-only entry means no proxy
      // for us rather than a silently ignored one.
      continue
    } else {
      servers.default = entry
    }
  }
  if (!servers.default) servers.default = servers.https || servers.http
  return servers
}

export function parseBypassList(value: string | undefined, separator: RegExp = /[,;]/): string[] {
  if (!value) return []
  return String(value)
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** NO_PROXY / ProxyOverride matching: `*`, `<local>`, `*.x.com`, `127.*`, `x.com` (+subdomains). */
export function isBypassed(hostname: string, patterns: string[]): boolean {
  const host = String(hostname).toLowerCase()
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase()
    if (!p) continue
    if (p === '*') return true
    if (p === '<local>') {
      if (!host.includes('.')) return true
      continue
    }
    if (p.startsWith('*.')) {
      const suffix = p.slice(1) // .x.com
      if (host === p.slice(2) || host.endsWith(suffix)) return true
      continue
    }
    if (p.endsWith('*')) {
      if (host.startsWith(p.slice(0, -1))) return true
      continue
    }
    if (host === p || host.endsWith('.' + p)) return true
  }
  return false
}

/** `127.0.0.1:7890` -> `http://127.0.0.1:7890`, credentials preserved, path dropped. */
export function normalizeProxy(raw: string): string | null {
  let value = String(raw).trim()
  if (!value) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'http://' + value
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const auth = url.username || url.password ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}@` : ''
    return `${url.protocol}//${auth}${url.host}`
  } catch {
    return null
  }
}

/**
 * Which proxy (if any) should carry `targetUrl`. Pure apart from the default
 * sources, both of which are injectable -- every test passes them explicitly.
 */
export function resolveProxyUrl(targetUrl: string, opts: ProxyOptions = {}): string | null {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return null
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null

  const env = opts.env || process.env
  const readSystem = opts.readSystemProxy || readWindowsSystemProxy
  const system = readSystem()
  const bypass = [...parseBypassList(envValue(env, 'NO_PROXY', 'no_proxy')), ...(system ? system.bypass : [])]
  if (isBypassed(target.hostname, bypass)) return null

  const scheme = target.protocol === 'https:' ? 'https' : 'http'
  const fromEnv = envValue(env, `${scheme.toUpperCase()}_PROXY`, `${scheme.toLowerCase()}_proxy`, 'ALL_PROXY', 'all_proxy')
  const raw = fromEnv || (system ? system.servers[scheme] || system.servers.default : undefined)
  return raw ? normalizeProxy(raw) : null
}

const agents = new Map<string, ProxyAgent>()

/**
 * Closes every pooled ProxyAgent. Keep-alive sockets would otherwise hold the
 * event loop open after a host shuts down (and after a test finishes).
 */
export async function closeProxyAgents(): Promise<void> {
  const open = [...agents.values()]
  agents.clear()
  await Promise.all(
    open.map(async (agent) => {
      try {
        await agent.close()
      } catch {
        // already closed
      }
    }),
  )
}

function agentFor(proxy: string): ProxyAgent | null {
  const cached = agents.get(proxy)
  if (cached) return cached
  try {
    const agent = new ProxyAgent(proxy)
    agents.set(proxy, agent)
    return agent
  } catch (err: any) {
    log('WARN', 'proxy_agent_invalid', { proxy, error: err && err.message })
    return null
  }
}

const PROXY_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'])

function isProxyConnectionError(err: any): boolean {
  let seen = 0
  let current = err
  while (current && seen++ < 6) {
    if (current.code && PROXY_CONNECTION_CODES.has(String(current.code))) return true
    current = current.cause
  }
  return false
}

/**
 * fetch() that honours the environment and the Windows system proxy.
 * No proxy -> the ordinary global fetch, unchanged. Proxy -> undici's fetch
 * with a cached ProxyAgent, falling back to direct when the proxy is down.
 */
export async function httpFetch(url: string, init?: RequestInit, opts?: ProxyOptions): Promise<Response> {
  const proxy = resolveProxyUrl(url, opts)
  if (!proxy) return await fetch(url, init)
  const agent = agentFor(proxy)
  if (!agent) return await fetch(url, init)
  try {
    const response = await undiciFetch(url, { ...(init as object), dispatcher: agent } as never)
    return response as unknown as Response
  } catch (err: any) {
    if (isProxyConnectionError(err)) {
      log('WARN', 'proxy_fallback_direct', { proxy, url, error: err && err.message })
      return await fetch(url, init)
    }
    throw err
  }
}
