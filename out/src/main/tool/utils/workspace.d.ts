/** Mio 工作区根 — 所有操作限定在此 */
export declare const PROJECT_ROOT: string;
export declare const WORKSPACE_DIR: string;
export declare const EVOLUTION_WORKSPACE_DIR: string;
export declare function wsLabel(ws?: string): string;
/** 路径安全检查 */
export declare function safePath(requested: string): string;
/** 解析工作区目录 */
export declare function resolveWorkspace(ws?: string): string;
/** 智能推断目标工作区 */
export declare function inferWorkspace(path: string, explicitWs?: string): string;
/** 剥离工作区目录名前缀，避免路径双重拼接 */
export declare function stripWorkspaceLabelPrefix(path: string, ws?: string): string;
/** 安全的工作区路径解析 */
export declare function safeWorkspacePath(requested: string, ws?: string): string;
