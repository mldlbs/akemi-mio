import { log } from '../../logger/Logger';
/**
 * WeiboCollector — 采集微博热搜榜
 *
 * 通过第三方公开 API 获取当前热搜话题，
 * 每条热搜作为一条 observation。
 */
export class WeiboCollector {
    constructor() {
        this.name = 'weibo-hot';
        this.intervalMs = 30 * 60 * 1000; // 每 30 分钟
        // 多个备选 API 端点
        this.apis = ['https://weibo.xxxlab.top/api/hot', 'https://api.emoao.com/api/weibo?format=json'];
        this.apiIndex = 0;
    }
    async collect() {
        const now = new Date();
        const ts = now.toISOString();
        const source = this.name;
        for (let attempt = 0; attempt < this.apis.length; attempt++) {
            const url = this.apis[this.apiIndex];
            this.apiIndex = (this.apiIndex + 1) % this.apis.length;
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                if (!res.ok)
                    continue;
                const data = await res.json();
                const items = extractWeiboItems(data);
                if (items.length === 0)
                    continue;
                log('INFO', 'weibo_collected', { count: items.length, url });
                return items.map((text, i) => ({
                    id: `weibo_${now.getTime()}_${i}`,
                    timestamp: ts,
                    source,
                    content: text,
                }));
            }
            catch (err) {
                log('WARN', 'weibo_collect_failed', { url, error: err.message });
            }
        }
        return [];
    }
}
function extractWeiboItems(data) {
    if (Array.isArray(data)) {
        return data.map((item) => {
            if (typeof item === 'string')
                return item;
            return item.title || item.word || item.name || item.content || JSON.stringify(item);
        });
    }
    if (data?.data && Array.isArray(data.data)) {
        return data.data
            .map((item) => {
            if (typeof item === 'string')
                return item;
            return item.title || item.word || item.name || item.content || '';
        })
            .filter(Boolean);
    }
    if (data?.list && Array.isArray(data.list)) {
        return data.list
            .map((item) => {
            if (typeof item === 'string')
                return item;
            return item.title || item.word || item.name || item.hotword || '';
        })
            .filter(Boolean);
    }
    if (data?.real && Array.isArray(data.real)) {
        return data.real.map((item) => item.word || item.title || '').filter(Boolean);
    }
    return [];
}
