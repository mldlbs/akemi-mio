import type { Collector, Observation } from '../types';
/**
 * RSSCollector — 采集用户订阅的 RSS 源
 *
 * 通过多个免费 RSS 转换服务获取 feed 内容。
 * 默认源可在 constructor 中配置。
 */
export declare class RSSCollector implements Collector {
    readonly name = "rss";
    readonly intervalMs: number;
    private feeds;
    private seenUrls;
    constructor(feeds?: string[]);
    collect(): Promise<Observation[]>;
    private fetchFeed;
}
