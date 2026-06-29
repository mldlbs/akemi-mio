import { resolve, join } from 'path';
import { DEV_PROJECT_ROOT, WORKSPACE_ROOT, WORKSPACE } from '../../config';
/** Mio 工作区根 — 所有操作限定在此 */
export const PROJECT_ROOT = DEV_PROJECT_ROOT || WORKSPACE_ROOT;
export const WORKSPACE_DIR = join(WORKSPACE_ROOT, 'projects', '__sandbox__');
export const EVOLUTION_WORKSPACE_DIR = WORKSPACE.evolution;
const WS_LABELS = {
    mcp: '__sandbox__',
    evolution: 'evolution_workspace',
    project: 'projects',
};
export function wsLabel(ws) {
    return WS_LABELS[ws || 'evolution'] || 'evolution_workspace';
}
/** 路径安全检查 */
export function safePath(requested) {
    const resolved = resolve(PROJECT_ROOT, requested);
    if (!resolved.startsWith(PROJECT_ROOT)) {
        if (DEV_PROJECT_ROOT && resolved.startsWith(DEV_PROJECT_ROOT))
            return resolved;
        throw new Error(`路径 ${requested} 超出项目根目录`);
    }
    return resolved;
}
/** 解析工作区目录 */
export function resolveWorkspace(ws) {
    if (ws === 'project' || !ws)
        return join(WORKSPACE_ROOT, 'projects');
    if (ws === 'evolution')
        return EVOLUTION_WORKSPACE_DIR;
    return WORKSPACE_DIR;
}
/** 智能推断目标工作区 */
export function inferWorkspace(path, explicitWs) {
    if (explicitWs)
        return explicitWs;
    const normalized = path.replace(/\\/g, '/');
    if (/^(sandbox|analysis|creativity|custom|tmp|living_plan)\//.test(normalized))
        return 'evolution';
    if (/^projects\//.test(normalized))
        return 'project';
    return 'evolution';
}
/** 剥离工作区目录名前缀，避免路径双重拼接 */
export function stripWorkspaceLabelPrefix(path, ws) {
    const label = wsLabel(ws);
    const normalized = path.replace(/\\/g, '/');
    if (label && normalized === label)
        return '.';
    if (label && normalized.startsWith(label + '/'))
        return normalized.slice(label.length + 1);
    return path;
}
/** 安全的工作区路径解析 */
export function safeWorkspacePath(requested, ws) {
    const wsDir = resolveWorkspace(ws);
    const cleanRequested = stripWorkspaceLabelPrefix(requested, ws);
    const resolved = resolve(wsDir, cleanRequested);
    if (!resolved.startsWith(wsDir))
        throw new Error(`路径 ${requested} 超出工作区目录`);
    return resolved;
}
