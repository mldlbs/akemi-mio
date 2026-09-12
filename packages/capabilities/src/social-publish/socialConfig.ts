import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { SocialMode } from './socialPolicy'

export interface SocialPlatformConfig {
  enabled?: boolean
}

export interface SocialConfig {
  mode: SocialMode
  platforms: Record<string, SocialPlatformConfig>
}

/** 解析 config.yaml 的 mode + platforms.*.enabled（与 social/cli.mjs、调度器共用） */
export function parseSocialConfig(raw: string): SocialConfig {
  const cfg: SocialConfig = { mode: 'assisted', platforms: {} }
  let platform: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const top = line.match(/^(\w+):\s*(.*)$/)
    const plat = line.match(/^ {2}(\w+):\s*$/)
    const prop = line.match(/^ {4}(\w+):\s*(.*)$/)
    if (top && !plat && !prop) {
      if (top[1] === 'mode') {
        const m = top[2].trim()
        if (m === 'safe' || m === 'assisted' || m === 'autopilot') cfg.mode = m
      }
      platform = null
      continue
    }
    if (plat) {
      platform = plat[1]
      cfg.platforms[platform] = {}
      continue
    }
    if (prop && platform && prop[1] === 'enabled') {
      cfg.platforms[platform].enabled = (prop[2].trim() || '').toLowerCase() === 'true'
    }
  }
  return cfg
}

/** 读取 social/config/config.yaml；不存在时用保守默认（assisted、平台全开） */
export function loadSocialConfig(socialDir: string): SocialConfig {
  const configPath = join(socialDir, 'config', 'config.yaml')
  if (!existsSync(configPath)) return { mode: 'assisted', platforms: {} }
  return parseSocialConfig(readFileSync(configPath, 'utf-8'))
}

