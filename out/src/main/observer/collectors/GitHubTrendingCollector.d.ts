import type { Collector, Observation } from '../types';
/**
 * GitHubTrendingCollector — GitHub Trending 热门项目
 *
 * 优先通过 DailyHotApi 获取，失败时 fallback 到 HTML scrape。
 */
export declare class GitHubTrendingCollector implements Collector {
    readonly name = "github-trending";
    readonly intervalMs: number;
    collect(): Promise<Observation[]>;
}
