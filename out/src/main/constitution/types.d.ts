export interface ProtectedPath {
    pattern: string;
    mutable: boolean;
    reason: string;
    layer: 'kernel' | 'cognitive' | 'knowledge' | 'evolution' | 'capability' | 'interface';
}
export interface ConstitutionDocument {
    version: string;
    immutablePaths: ProtectedPath[];
    mutablePaths: ProtectedPath[];
    updatedAt: number;
}
export type EnforcementMode = 'warn' | 'enforce' | 'off';
export interface ConstitutionCheck {
    allowed: boolean;
    violation?: {
        path: string;
        pattern: string;
        reason: string;
        severity: 'error' | 'warn';
        layer: string;
    };
}
/** Runtime Kernel 不可变目录前缀（自动推导，兼容 dev/prod） */
export declare function getKernelPrefixes(): string[];
/**
 * 判断路径是否属于 Runtime Kernel（基于前缀匹配，路径分隔符归一化）。
 * 用于在 ConstitutionEngine 加载前的快速判断。
 */
export declare function isKernelPath(absolutePath: string, prefixes?: string[]): boolean;
export declare function normalizePath(p: string): string;
