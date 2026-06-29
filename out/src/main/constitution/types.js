/**
 * 根据运行时 __dirname 动态解析 Kernel 路径前缀。
 * 开发模式: /path/to/src/main/constitution/ → src/main/core/
 * 生产模式: /path/to/dist/main/constitution/ → dist/main/core/
 * 确保打包后 isKernelPath 依然有效。
 */
function resolveKernelPrefixes() {
    const thisDir = __dirname.replace(/\\/g, '/');
    // __dirname = <root>/<outDir>/constitution/，取上一级 = <root>/<outDir>/
    const parentDir = thisDir.replace(/\/[^/]+$/, '');
    return [parentDir + '/core/', parentDir + '/constitution/', parentDir + '/bootstrap/'];
}
/** Runtime Kernel 不可变目录前缀（自动推导，兼容 dev/prod） */
export function getKernelPrefixes() {
    return resolveKernelPrefixes();
}
/**
 * 判断路径是否属于 Runtime Kernel（基于前缀匹配，路径分隔符归一化）。
 * 用于在 ConstitutionEngine 加载前的快速判断。
 */
export function isKernelPath(absolutePath, prefixes) {
    const normalized = absolutePath.replace(/\\/g, '/');
    const resolved = prefixes ?? resolveKernelPrefixes();
    return resolved.some((prefix) => normalized.startsWith(prefix));
}
export function normalizePath(p) {
    return p.replace(/\\/g, '/');
}
