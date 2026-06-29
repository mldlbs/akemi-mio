/**
 * SandboxValidator — 自主生成的 HTML/JS 产物质量验证器。
 *
 * 在 EvolutionReviewer 的 verify() 阶段被调用，对 sandbox 目录下的 HTML 产物
 * 做静态分析，检查常见渲染/逻辑问题，形成质量门禁。
 *
 * 检查项：
 * - HTML 结构完整性（DOCTYPE、body、script 闭合）
 * - 资源可达性（CDN 引用、本地文件依赖）
 * - p5.js 常见渲染错误（draw() 中 image() 覆盖粒子、setup 尺寸问题）
 * - 通用 JS 反模式（未定义变量、无错误边界、resize 未处理）
 */
export interface SandboxValidationIssue {
    severity: 'error' | 'warning' | 'info';
    rule: string;
    message: string;
    line?: number;
    fix?: string;
}
export interface SandboxValidationResult {
    passed: boolean;
    html: {
        valid: boolean;
        errors: string[];
    };
    resources: {
        external: string[];
        missing: string[];
        warnings: string[];
    };
    rendering: SandboxValidationIssue[];
    summary: string;
}
export declare function validateSandboxHtml(filePath: string): SandboxValidationResult;
/**
 * 扫描 sandbox 目录下所有 HTML 产物并验证
 */
export declare function validateAllSandboxes(sandboxRoot: string): {
    results: Record<string, SandboxValidationResult>;
    total: number;
    passed: number;
    failed: number;
};
