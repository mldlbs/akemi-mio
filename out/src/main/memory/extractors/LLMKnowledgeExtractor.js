export class LLMKnowledgeExtractor {
    constructor() {
        this.llm = null;
    }
    setLlm(llm) {
        this.llm = llm;
    }
    async extract(content) {
        if (!this.llm || !content.trim())
            return [];
        const prompt = `从以下文本中提取所有实体-属性-值三元组。只返回 JSON 数组：
[{"entity": "...", "attribute": "...", "value": "...", "confidence": 0.0-1.0}]

文本：${content.slice(0, 500)}`;
        try {
            const result = await this.llm.chatJson(prompt, {
                system: '你是一个知识提取器。只提取明确陈述的事实，不要编造。',
                temperature: 0.1,
                maxTokens: 500,
            });
            if (Array.isArray(result)) {
                return result.filter((t) => t.entity && t.attribute && t.value && typeof t.confidence === 'number');
            }
            return [];
        }
        catch {
            return [];
        }
    }
}
