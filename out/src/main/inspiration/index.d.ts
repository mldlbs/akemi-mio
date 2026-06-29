import { GitHubInspiration } from './GitHubInspiration';
export declare let gitHubInspiration: GitHubInspiration | null;
/**
 * 初始化 GitHub 灵感服务
 * @param cacheDir 缓存目录（推荐 evolution_workspace/inspiration/）
 * @param githubToken 可选 GitHub Token，提高 API 频率限制
 */
export declare function initInspiration(cacheDir: string, githubToken?: string): GitHubInspiration;
export { GitHubInspiration };
