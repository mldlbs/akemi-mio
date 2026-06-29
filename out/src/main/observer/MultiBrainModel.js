import { log } from '../logger/Logger';
const BRAIN_ORDER = ['perception', 'curiosity', 'analyst', 'writer'];
const BRAIN_SYSTEM_PROMPTS = {
    perception: '你是秋山澪的感知脑。你只会列举事实，不做分析不写结论。\n' +
        '格式：每行一个观察，用「观察到：」开头。\n' +
        '禁止使用：然而、不仅、而且、因此、总之、值得关注、引人深思。',
    curiosity: '你是秋山澪的好奇脑。你只对矛盾、反常、未解的问题感兴趣。\n' +
        '格式：每行一个好奇点，用「好奇：」开头。\n' +
        '禁止使用：值得注意的是、不可忽视、某种意义上。',
    analyst: '你是秋山澪的分析脑。你只做因果连接。\n' +
        '格式：每行一个因果链，用「因为→所以」格式。\n' +
        '禁止使用：背后隐藏着、复杂而微妙、从某种意义上说、为我们提供了。',
    writer: '你是秋山澪的写作脑。用口语化的中文写一段随笔。\n' +
        '像一个活人在说话，不是报告。不要列点，不要小标题。\n' +
        '禁止使用：综上所述、由此可见、毋庸置疑、众所周知。',
};
const BRAIN_TEMPERATURES = {
    perception: 0.7,
    curiosity: 0.8,
    analyst: 0.3,
    writer: 0.9,
};
/**
 * MultiBrainModel — 四脑认知模型（并行版）
 *
 * 升级点：
 * - perception / curiosity / analyst 独立并行执行，不依赖前序输出
 * - writer 在所有前序完成后运行，接收完整上下文
 * - 任一脑失败不影响其他脑
 */
export class MultiBrainModel {
    constructor(llm) {
        this.llm = llm;
    }
    async process(result, mode) {
        const researchSummary = this.buildResearchSummary(result);
        // 前三脑并行执行
        const [perception, curiosity, analyst] = await Promise.all([
            this.runBrain('perception', mode, researchSummary),
            this.runBrain('curiosity', mode, researchSummary),
            this.runBrain('analyst', mode, researchSummary),
        ]);
        const pOut = {
            brain: 'perception',
            generatedAt: new Date().toISOString(),
            content: perception ?? researchSummary,
            confidence: perception ? 0.7 : 0.3,
        };
        const cOut = {
            brain: 'curiosity',
            generatedAt: new Date().toISOString(),
            content: curiosity ?? researchSummary,
            confidence: curiosity ? 0.7 : 0.3,
        };
        const aOut = {
            brain: 'analyst',
            generatedAt: new Date().toISOString(),
            content: analyst ?? researchSummary,
            confidence: analyst ? 0.7 : 0.3,
        };
        // writer 接收前三脑输出作为上下文
        const writerContext = [
            `## 感知脑\n${pOut.content.slice(0, 1500)}`,
            `## 好奇脑\n${cOut.content.slice(0, 1500)}`,
            `## 分析脑\n${aOut.content.slice(0, 1500)}`,
        ].join('\n\n');
        const writer = await this.runBrain('writer', mode, writerContext);
        const wOut = {
            brain: 'writer',
            generatedAt: new Date().toISOString(),
            content: writer ?? writerContext,
            confidence: writer ? 0.7 : 0.3,
        };
        const outputs = [pOut, cOut, aOut, wOut];
        log('INFO', 'brain_parallel_completed', {
            brains: outputs.map((o) => `${o.brain}:${o.confidence}`).join(', '),
        });
        return outputs;
    }
    buildResearchSummary(result) {
        const lines = [];
        lines.push(`主题研究包含 ${result.facts.length} 条事实、${result.timeline.length} 个时间点、${result.conflicts.length} 个冲突。`);
        if (result.facts.length > 0) {
            lines.push('');
            lines.push('事实：');
            lines.push(...result.facts.slice(0, 10).map((f) => `- ${f}`));
        }
        if (result.timeline.length > 0) {
            lines.push('');
            lines.push('时间线：');
            lines.push(...result.timeline.slice(0, 10).map((t) => `- ${t.time}: ${t.event}`));
        }
        if (result.conflicts.length > 0) {
            lines.push('');
            lines.push('冲突：');
            lines.push(...result.conflicts.map((c) => `- ${c.partyA} vs ${c.partyB}: ${c.nature}`));
        }
        return lines.join('\n');
    }
    async runBrain(brain, mode, previousContent) {
        const system = BRAIN_SYSTEM_PROMPTS[brain];
        const temperature = BRAIN_TEMPERATURES[brain];
        let userPrompt;
        if (brain === 'perception') {
            userPrompt = `以下是研究结果：\n${previousContent}\n\n你观察到了什么模式？`;
        }
        else if (brain === 'writer') {
            userPrompt = `${previousContent}\n\n用第一人称「我」写一段随笔，别列点，像在说话。`;
        }
        else {
            userPrompt = `前序分析：${previousContent}\n\n你的分析是什么？`;
        }
        const llmResult = await this.llm.generate(userPrompt, { system, temperature, maxTokens: 4096 });
        if (llmResult.error) {
            log('WARN', 'brain_failed', { brain, error: llmResult.error });
            return null;
        }
        return llmResult.data ?? null;
    }
}
