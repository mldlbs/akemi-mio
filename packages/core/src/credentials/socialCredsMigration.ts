import { existsSync, readFileSync, unlinkSync } from 'fs'

/** 旧版明文 social/config/.creds.json（大写键）→ CredentialsManager（小写键）映射（设计 4.4） */
export const SOCIAL_CREDS_KEY_MIGRATION: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'telegram_bot_token',
  TELEGRAM_CHAT_ID: 'telegram_chat_id',
  X_BEARER_TOKEN: 'x_bearer_token',
  X_ACCESS_TOKEN: 'x_access_token',
  X_REFRESH_TOKEN: 'x_refresh_token',
  WEIBO_COOKIE: 'weibo_cookie',
  XHS_COOKIE: 'xhs_cookie',
  DOUYIN_COOKIE: 'douyin_cookie',
  ZHIHU_COOKIE: 'zhihu_cookie',
  WECHAT_MP_APPID: 'wechat_mp_appid',
  WECHAT_MP_SECRET: 'wechat_mp_secret',
  SOCIAL_PROXY: 'social_proxy',
}

/** 把 .creds.json 的键按映射表转为 [小写键, 值]；未知键 / 空值跳过 */
export function mapSocialCreds(store: Record<string, unknown>): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(store)) {
    const target = SOCIAL_CREDS_KEY_MIGRATION[key]
    if (target && value != null) entries.push([target, String(value)])
  }
  return entries
}

/**
 * 一次性迁移：读明文 .creds.json → 逐条 set(key, value) → 全部写入成功后才删除明文文件。
 * 返回迁移键数；文件不存在或无可迁移键时返回 0 且不删除文件。
 * 任一次 set 抛错会中止并保留明文文件（避免凭据丢失）。
 */
export function migrateSocialCredsFile(credsPath: string, set: (key: string, value: string) => void): number {
  if (!existsSync(credsPath)) return 0
  const store = JSON.parse(readFileSync(credsPath, 'utf-8')) as Record<string, unknown>
  const entries = mapSocialCreds(store)
  if (entries.length === 0) return 0
  for (const [key, value] of entries) set(key, value)
  unlinkSync(credsPath)
  return entries.length
}