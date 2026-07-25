/**
 * credential-keys — 番茄小说凭据 KEY 常量及读取辅助
 */

import { getCredentialsManager } from '../tool/deps'
import { CRED } from './types'

export { CRED, CRED_PREFIX } from './types'

/**
 * 从凭据管理器读取指定键的值。
 */
export function getCredentialValue(key: string): string | undefined {
  const cm = getCredentialsManager()
  if (!cm) return undefined
  return cm.get(key) ?? undefined
}
