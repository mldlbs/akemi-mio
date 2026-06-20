import { createHash } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { log } from '../logger/Logger'

interface AllowlistEntry {
  path: string
  sha256: string
  name: string
  addedAt: number
}

interface PluginAllowlist {
  version: 1
  entries: AllowlistEntry[]
}

const ALLOWLIST_FILE = 'plugins.allowlist.json'

function getAllowlistPath(): string {
  return join(app.getPath('userData'), ALLOWLIST_FILE)
}

function loadAllowlist(): PluginAllowlist {
  try {
    const p = getAllowlistPath()
    if (!existsSync(p)) return { version: 1, entries: [] }
    const raw = readFileSync(p, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { version: 1, entries: [] }
  }
}

function computeHash(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Verify a plugin file against the allowlist.
 * Returns true if the plugin is trusted (hash matches an allowlist entry).
 * Prints a warning if untrusted.
 */
export function verifyPlugin(filePath: string, pluginName: string): boolean {
  // Built-in plugins are always trusted (they ship with the app and are loaded from source, not userData)
  if (!filePath.includes(app.getPath('userData'))) {
    return true
  }

  const allowlist = loadAllowlist()
  const hash = computeHash(filePath)
  const match = allowlist.entries.find((e) => e.sha256 === hash)

  if (!match) {
    log('WARN', 'plugin_untrusted', {
      name: pluginName,
      path: filePath,
      sha256: hash,
      message: '插件不在 allowlist 中，已跳过加载。如需信任，将以上 sha256 添加到 plugins.allowlist.json',
    })
    return false
  }

  log('INFO', 'plugin_verified', { name: pluginName, sha256: hash.slice(0, 12) })
  return true
}
