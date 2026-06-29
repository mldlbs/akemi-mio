import { log } from '../logger/Logger';
/**
 * FermentationEngine — 发酵引擎
 *
 * 读取近期 observations，调用 Observer-Mio 做关联，
 * 输出 association clusters。
 * strength > 0.7 的 cluster 触发写作。
 */
export class FermentationEngine {
    constructor(llm, store) {
        this.writingThreshold = 0.7;
        this.llm = llm;
        this.store = store;
    }
    /**
     * 执行一次发酵
     * @param sessionLabel 时段标签: 'morning' | 'afternoon' | 'night'
     */
    async ferment(sessionLabel) {
        log('INFO', 'fermentation_start', { session: sessionLabel });
        const observations = this.store.readRecent(3);
        if (observations.length === 0) {
            log('INFO', 'fermentation_empty');
            return { generatedAt: new Date().toISOString(), clusters: [] };
        }
        const obsText = observations
            .slice(0, 60)
            .map((o) => `[${o.source}] ${o.content}`)
            .join('\n');
        const previous = this.store.readRecentAssociations(3);
        const prevText = previous.length > 0
            ? '\n\n近期关联主题：\n' +
                previous
                    .flatMap((r) => r.clusters)
                    .map((c) => `- ${c.theme} (${c.associations.join(', ')})`)
                    .join('\n')
            : '';
        const prompt = `你是一个观察者，下面是近期收集到的生活碎片。请从这些碎片中找出 recurring themes——那些反复出现、相互呼应的片段。

不需要准确，凭感觉就好。允许矛盾，允许模糊。

${obsText}${prevText}

按以下 JSON 格式输出关联结果，不要包含其他内容：
{
  "clusters": [
    {
      "theme": "简短的主题名",
      "associations": ["关联词1", "关联词2"],
      "strength": 0.8
    }
  ]
}

每个 cluster 的 strength 在 0-1 之间，越强的关联越可能发展成文字。strength 低于 0.3 的不要输出。`;
        const result = await this.llm.generateJson(prompt, {
            temperature: 0.6,
            maxTokens: 2048,
        });
        if (result.error) {
            log('WARN', 'fermentation_failed', { error: result.error });
            return { generatedAt: new Date().toISOString(), clusters: [] };
        }
        const clusters = result.data?.clusters?.filter((c) => c.strength >= 0.3) || [];
        const output = {
            generatedAt: new Date().toISOString(),
            clusters,
        };
        this.store.saveAssociation(output);
        log('INFO', 'fermentation_done', {
            session: sessionLabel,
            clusters: clusters.length,
            strong: clusters.filter((c) => c.strength >= this.writingThreshold).length,
        });
        return output;
    }
    getWritingThreshold() {
        return this.writingThreshold;
    }
    setWritingThreshold(t) {
        this.writingThreshold = Math.max(0, Math.min(1, t));
    }
}
