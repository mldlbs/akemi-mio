/**
 * 加载宪法文档。如果不存在则创建默认文档。
 */
export declare function loadConstitution(dir: string): {
    json: any;
    md: string;
};
/**
 * 校验宪法文档结构。
 * 返回错误信息数组，空数组表示通过。
 */
export declare function validateConstitution(doc: any): string[];
export declare function createDefaultJson(): {
    version: string;
    immutablePaths: {
        pattern: string;
        mutable: boolean;
        reason: string;
        layer: 'kernel';
    }[];
    mutablePaths: any[];
    updatedAt: number;
};
