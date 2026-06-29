import type { ObserverLlmService } from './ObserverLlmService';
import type { ObserverStore } from './ObserverStore';
import type { AssociationResult } from './types';
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
export declare class WritingGate {
    private llm;
    private store;
    private writingPrompt;
    constructor(llm: ObserverLlmService, store: ObserverStore);
    setWritingPrompt(prompt: string): void;
    tryWrite(association: AssociationResult): Promise<string | null>;
}
