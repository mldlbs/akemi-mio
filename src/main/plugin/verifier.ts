import { createHash, verify } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { log } from '../logger/Logger'
import { PLUGIN_SIGNING_PUBLIC_KEY, SIGNATURE_COMMENT_PREFIX } from './signing-key'

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
 * Verify a plugin file — accept if:
 *  1. Built-in plugin (outside userData), OR
 *  2. Has a valid Ed25519 signature, OR
 *  3. SHA-256 matches an allowlist entry (legacy fallback)
 *
 * Returns true if the plugin is trusted.
 */
export function verifyPlugin(filePath: string, pluginName: string): boolean {
  // 1. Built-in plugins are always trusted
  if (!filePath.includes(app.getPath('userData'))) {
    return true
  }

  // 2. Try Ed25519 signature
  if (verifyEd25519(filePath)) {
    log('INFO', 'plugin_verified_signature', { name: pluginName })
    return true
  }

  // 3. Legacy allowlist fallback
  const allowlist = loadAllowlist()
  const hash = computeHash(filePath)
  const match = allowlist.entries.find((e) => e.sha256 === hash)

  if (!match) {
    log('WARN', 'plugin_untrusted', {
      name: pluginName,
      path: filePath,
      sha256: hash,
      message: '插件不在 allowlist 中，已跳过加载。如需信任，将以上 sha256 添加到 plugins.allowlist.json 或添加 Ed25519 签名',
    })
    return false
  }

  log('INFO', 'plugin_verified', { name: pluginName, sha256: hash.slice(0, 12) })
  return true
}

/**
 * Verify an Ed25519 signature embedded in the plugin file.
 * The signature comment must be the LAST line of the file:
 *   // @akemi-mio-signature:<base64-encoded-signature>
 */
function verifyEd25519(filePath: string): boolean {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return false
  }

  const lines = content.split('\n')
  // Filter out trailing empty lines to find the last meaningful line
  let lastLineIndex = lines.length - 1
  while (lastLineIndex >= 0 && lines[lastLineIndex].trim() === '') {
    lastLineIndex--
  }
  if (lastLineIndex < 0) return false

  const lastLine = lines[lastLineIndex].trim()
  if (!lastLine.startsWith(SIGNATURE_COMMENT_PREFIX)) return false

  const signatureBase64 = lastLine.slice(SIGNATURE_COMMENT_PREFIX.length).trim()
  if (!signatureBase64) return false

  // Reconstruct the file content without the signature line
  const contentLines = lines.slice(0, lastLineIndex).join('\n')

  // If the content was originally terminated by \n before signature, keep it
  const contentToVerify = lines[lastLineIndex - 1] === '' ? contentLines + '\n' : contentLines

  try {
    const signature = Buffer.from(signatureBase64, 'base64')
    const publicKey = Buffer.from(PLUGIN_SIGNING_PUBLIC_KEY, 'hex')
    return verify(null, Buffer.from(contentToVerify, 'utf-8'), publicKey, signature) as boolean
  } catch {
    return false
  }
}
