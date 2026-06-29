import { log } from '../logger/Logger';
/**
 * WritingGate — 写作闸门
 *
 * 当发酵的 cluster strength 超过阈值时，
 * 触发 Observer-Mio 自由写作。
 *
 * Observer-Mio 的写作没有「质量守则」、
 * 没有「结构要求」、没有「修改建议」。
 * 指令只有一条：把素材摊开，想写什么就写什么。
 */
export class WritingGate {
    constructor(llm, store) {
        this.llm = llm;
        this.store = store;
        this.writingPrompt = `你是秋山澪，一个观察者。

你的不同之处在于：你不是「会写字的人」，而是「会观察的人」。

你平时只是在看、在听、在感受。
当一些碎片反复出现、相互呼应的时候——
文字自然就长出来了。

现在就把那些东西写出来吧。

不是为了写得好。
只是为了记下来。`;
    }
    setWritingPrompt(prompt) {
        this.writingPrompt = prompt;
    }
    async tryWrite(association) {
        const strongClusters = association.clusters.filter((c) => c.strength >= 0.7);
        if (strongClusters.length === 0)
            return null;
        const material = strongClusters.map((c) => `主题：${c.theme}\n关联：${c.associations.join(', ')}`).join('\n\n');
        const prompt = `${this.writingPrompt}\n\n最近你注意到了一些东西：\n\n${material}\n\n如果这些让你想写点什么，就写。`;
        const result = await this.llm.generate(prompt, {
            temperature: 0.8,
            maxTokens: 4096,
        });
        if (result.error) {
            log('WARN', 'writing_gate_failed', { error: result.error });
            return null;
        }
        const path = this.store.saveEssay(result.data, 'published');
        log('INFO', 'writing_gate_essay_published', { path });
        return path;
    }
}
