import type { EnforcementMode, ConstitutionCheck } from './types';
import { ProtectedPaths } from './ProtectedPaths';
export type ConstitutionEvent = 'constitution.violation' | 'constitution.mode_changed';
export interface EngineEventPayload {
    'constitution.violation': {
        path: string;
        pattern: string;
        reason: string;
        layer: string;
        mode: string;
    };
    'constitution.mode_changed': {
        mode: EnforcementMode;
        previous: EnforcementMode;
    };
}
export type EngineListener<E extends ConstitutionEvent> = (payload: EngineEventPayload[E]) => void;
/**
 * Constitution Engine — 系统最高治理引擎。
 *
 * 职责：
 * 1. 加载 & 校验宪法文档
 * 2. 在执行文件写入前检查目标路径是否受保护
 * 3. 三级运行模式：warn / enforce / off
 * 4. 发出违例事件供审计
 */
export declare class ConstitutionEngine {
    private paths;
    private mode;
    private initialized;
    private listeners;
    get isInitialized(): boolean;
    get enforcementMode(): EnforcementMode;
    get protectedPaths(): ProtectedPaths;
    /** 初始化：从指定目录加载宪法文档 */
    initialize(constitutionDir?: string): Promise<void>;
    /**
     * 设置执行模式。
     * warn: 仅记录日志，不阻止操作
     * enforce: 阻止操作并抛出错误
     * off: 完全绕过
     */
    setEnforcementMode(mode: EnforcementMode): void;
    /**
     * 检查写入目标路径是否合规。
     * 返回 ConstitutionCheck，调用方据此决定是否放行。
     */
    checkWrite(absolutePath: string): ConstitutionCheck;
    on<E extends ConstitutionEvent>(event: E, listener: EngineListener<E>): () => void;
    private emit;
}
