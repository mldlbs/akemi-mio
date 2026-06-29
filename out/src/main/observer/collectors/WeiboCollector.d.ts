import type { Collector, Observation } from '../types';
/**
 * WeiboCollector — 采集微博热搜榜
 *
 * 通过第三方公开 API 获取当前热搜话题，
 * 每条热搜作为一条 observation。
 */
export declare class WeiboCollector implements Collector {
    readonly name = "weibo-hot";
    readonly intervalMs: number;
    private apis;
    private apiIndex;
    collect(): Promise<Observation[]>;
}
