import type { Collector, Observation } from '../types';
/**
 * BilibiliCollector — B站热搜和热门视频
 *
 * 官方公开 API（无需 WBI 签名）：
 * - 热搜词: s.search.bilibili.com/main/hotword
 * - 热门视频: api.bilibili.com/x/web-interface/popular
 */
export declare class BilibiliCollector implements Collector {
    readonly name = "bilibili";
    readonly intervalMs: number;
    private headers;
    collect(): Promise<Observation[]>;
}
