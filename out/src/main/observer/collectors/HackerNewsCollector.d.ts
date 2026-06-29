import type { Collector, Observation } from '../types';
/**
 * HackerNewsCollector — 采集 HackerNews 技术趋势
 *
 * 使用官方 Firebase API：https://hacker-news.firebaseio.com/v0/
 * 每次采集 top 30 条，过滤掉已见的。
 */
export declare class HackerNewsCollector implements Collector {
    readonly name = "hackernews";
    readonly intervalMs: number;
    private seenUrls;
    collect(): Promise<Observation[]>;
}
