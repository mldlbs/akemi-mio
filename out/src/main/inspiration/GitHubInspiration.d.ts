/** 从 GitHub API 返回的原始仓库信息 */
export interface RawRepoInfo {
    owner: string;
    repo: string;
    url: string;
    stars: number;
    description: string;
    topics: string[];
    language: string;
}
/** 经过分析和缓存的灵感条目 */
export interface InspirationEntry {
    repo: RawRepoInfo;
    fetchedAt: number;
    readmePreview: string;
    keyFeatures: string[];
    architectureHighlights: string[];
}
/**
 * GitHubInspiration — 定期从 GitHub 搜索优秀项目，提取灵感和架构参考。
 *
 * 使用方式：
 * 1. 初始化时传入 cacheDir（推荐 evolution_workspace/inspiration/）
 * 2. 每次调用 getSources() 检查缓存是否过期，过期则刷新
 * 3. 返回 CreativitySource[]，注入到创造力引擎
 */
export declare class GitHubInspiration {
    private cachePath;
    private cache;
    /** 可选 GitHub Token，提高 API 频率限制 */
    private token;
    constructor(cacheDir: string, token?: string);
    /**
     * 获取灵感来源（缓存的或新抓取的）
     */
    getSources(): Array<{
        name: string;
        content: string;
        type: 'knowledge';
        weight: number;
    }>;
    /**
     * 从 GitHub 刷新数据
     */
    refresh(): Promise<void>;
    /**
     * 搜索 GitHub 仓库
     */
    private searchRepos;
    /**
     * 获取仓库 README
     */
    private fetchReadme;
    /**
     * 从 README 提取关键信息
     */
    private analyzeReadme;
    /**
     * 将缓存条目转为 CreativitySource 格式
     */
    private entriesToSources;
    private loadCache;
    private saveCache;
    /**
     * 强制立即刷新（用于手动触发）
     */
    forceRefresh(): Promise<void>;
}
