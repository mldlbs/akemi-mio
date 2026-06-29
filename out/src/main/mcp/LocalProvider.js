import { LocalProviderAdapter } from '../tool/definitions/LocalProviderAdapter';
import { setMemoryService as setDepsMemoryService } from '../tool/deps';
import { WORKSPACE_DIR as WS_DIR } from '../tool/utils/workspace';
const _adapter = new LocalProviderAdapter();
let _memoryService = null;
export function setMemoryService(ms) {
    _memoryService = ms;
    setDepsMemoryService(ms);
}
/**
 * LocalProvider — 向后兼容适配器。
 * 所有工具实现已迁移到 src/main/tool/definitions/ 下独立文件，
 * 通过 LocalProviderAdapter 统一派发。
 */
export class LocalProvider {
    constructor() {
        this.name = '@builtin/core';
    }
    getToolDefinitions() {
        return _adapter.getToolDefinitions();
    }
    async callTool(name, args) {
        return _adapter.callTool(name, args);
    }
}
// 保持被 ServerManager 引用的导出
export const WORKSPACE_DIR = WS_DIR;
