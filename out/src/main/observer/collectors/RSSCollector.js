import { log } from '../../logger/Logger';
/**
 * RSSCollector — 采集用户订阅的 RSS 源
 *
 * 通过多个免费 RSS 转换服务获取 feed 内容。
 * 默认源可在 constructor 中配置。
 */
export class RSSCollector {
    constructor(feeds) {
        this.name = 'rss';
        this.intervalMs = 60 * 60 * 1000; // 每 60 分钟
        this.seenUrls = new Set();
        this.feeds = feeds ?? [
            // 科技
            'https://feeds.feedburner.com/ruanyifeng',
            // 央视新闻
            'http://www.cctv.com/program/rss/02/01/index.xml',
            'http://www.cctv.com/program/rss/02/02/index.xml',
            'http://www.cctv.com/program/rss/02/04/index.xml',
            'http://www.cctv.com/program/rss/02/06/index.xml',
            // 人民网
            'http://www.people.com.cn/rss/politics.xml',
            'http://www.people.com.cn/rss/world.xml',
            'http://www.people.com.cn/rss/society.xml',
            // 新华网
            'http://www.xinhuanet.com/politics/news_politics.xml',
            'http://www.xinhuanet.com/world/news_world.xml',
            'http://www.xinhuanet.com/tech/news_tech.xml',
            'http://www.xinhuanet.com/fortune/news_fortune.xml',
            // RSSHub 代理（澎湃 / 财新）
            'https://rsshub.app/thepaper/featured',
            'https://rsshub.app/caixin/latest',
            // 技术资讯
            'https://feeds.feedburner.com/InfoqChinese',
            'https://www.jiqizhixin.com/rss',
            'https://36kr.com/feed',
        ];
    }
    async collect() {
        const now = new Date();
        const ts = now.toISOString();
        const all = [];
        let idCounter = 0;
        for (const feedUrl of this.feeds) {
            try {
                const items = await this.fetchFeed(feedUrl);
                for (const item of items) {
                    const url = item.link || item.title || '';
                    if (url && this.seenUrls.has(url))
                        continue;
                    if (url)
                        this.seenUrls.add(url);
                    const content = item.title || stripHtml(item.description || '');
                    if (!content || content.length < 5)
                        continue;
                    all.push({
                        id: `rss_${now.getTime()}_${idCounter++}`,
                        timestamp: item.pubDate || ts,
                        source: feedUrl,
                        content: content.slice(0, 200),
                    });
                }
            }
            catch (err) {
                log('WARN', 'rss_collect_failed', { feed: feedUrl, error: err.message });
            }
        }
        if (this.seenUrls.size > 10000) {
            this.seenUrls = new Set([...this.seenUrls].slice(-5000));
        }
        log('INFO', 'rss_collected', { feeds: this.feeds.length, new_items: all.length });
        return all;
    }
    async fetchFeed(feedUrl) {
        const services = [`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`];
        for (const serviceUrl of services) {
            try {
                const res = await fetch(serviceUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    signal: AbortSignal.timeout(15000),
                });
                if (!res.ok)
                    continue;
                const json = await res.json();
                if (json?.items && Array.isArray(json.items)) {
                    return json.items.map((item) => ({
                        title: item.title,
                        link: item.link || item.guid || '',
                        description: item.description || item.content,
                        pubDate: item.pubDate || item.date,
                    }));
                }
            }
            catch {
                continue;
            }
        }
        return [];
    }
}
function stripHtml(text) {
    return text
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}
