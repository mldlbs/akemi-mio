import { GitHubInspiration } from './GitHubInspiration'
import { log } from '../logger/Logger'

export let gitHubInspiration: GitHubInspiration | null = null

/**
 * 初始化 GitHub 灵感服务
 * @param cacheDir 缓存目录（推荐 evolution_workspace/inspiration/）
 * @param githubToken 可选 GitHub Token，提高 API 频率限制
 */
export function initInspiration(cacheDir: string, githubToken?: string): GitHubInspiration {
  if (!gitHubInspiration) {
    gitHubInspiration = new GitHubInspiration(cacheDir, githubToken)
    log('INFO', 'inspiration_initialized', { cacheDir })
  }
  return gitHubInspiration
}

export { GitHubInspiration }
