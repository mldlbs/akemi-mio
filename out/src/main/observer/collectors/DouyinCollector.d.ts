import type { Collector, Observation } from '../types';
/**
 * DouyinCollector — 抖音热搜榜
 *
 * 通过第三方聚合 API（Cloudflare CDN，国内可访问）。
 */
export declare class DouyinCollector implements Collector {
    readonly name = "douyin";
    readonly intervalMs: number;
    private apis;
    collect(): Promise<Observation[]>;
}
