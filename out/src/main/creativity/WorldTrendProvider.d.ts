/**
 * WorldTrendProvider — 从 Observer trends/ + observations/ 读取真实片段
 *
 * 不再返回干巴巴的关键词，而是返回具体的观察片段。
 * "高考" → "一个考生查分时全家屏住呼吸的视频获得300万点赞"
 */
export declare class WorldTrendProvider {
    private observerDir;
    private consumedNames;
    private rng;
    constructor(observerDir: string, seed?: number);
    resetConsumed(): void;
    /**
     * 返回精选观察片段（3-6 条），按热度排序、轮换选取。
     */
    getTrends(): string[];
    /**
     * 获取最近几天的精选观察片段（结构化，供工具使用）。
     */
    getTrendSignals(days?: number, limit?: number): {
        keyword: string;
        snippets: string[];
        score: number;
    }[];
    /**
     * 从 insights/ 取主题名。
     */
    getInsights(): string[];
    private loadSignals;
    private buildObsMap;
}
