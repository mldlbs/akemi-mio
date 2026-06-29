import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger/Logger';
import { ProtectedPaths } from './ProtectedPaths';
import { WORKSPACE } from '../config';
/**
 * Constitution Engine — 系统最高治理引擎。
 *
 * 职责：
 * 1. 加载 & 校验宪法文档
 * 2. 在执行文件写入前检查目标路径是否受保护
 * 3. 三级运行模式：warn / enforce / off
 * 4. 发出违例事件供审计
 */
export class ConstitutionEngine {
    constructor() {
        this.paths = new ProtectedPaths();
        this.mode = 'warn';
        this.initialized = false;
        this.listeners = new Map();
    }
    get isInitialized() {
        return this.initialized;
    }
    get enforcementMode() {
        return this.mode;
    }
    get protectedPaths() {
        return this.paths;
    }
    /** 初始化：从指定目录加载宪法文档 */
    async initialize(constitutionDir) {
        if (this.initialized)
            return;
        const dir = constitutionDir || path.resolve(WORKSPACE.evolution, 'constitution');
        const jsonPath = path.join(dir, 'constitution.json');
        if (fs.existsSync(jsonPath)) {
            try {
                const raw = fs.readFileSync(jsonPath, 'utf-8');
                const doc = JSON.parse(raw);
                if (!doc.version || !Array.isArray(doc.immutablePaths)) {
                    log('WARN', 'constitution_invalid', { path: jsonPath });
                    this.initialized = true;
                    return;
                }
                this.paths.load(doc.immutablePaths, doc.mutablePaths || []);
                log('INFO', 'constitution_loaded', {
                    version: doc.version,
                    immutableCount: doc.immutablePaths.length,
                    mode: this.mode,
                });
            }
            catch (err) {
                log('WARN', 'constitution_load_failed', { path: jsonPath, error: String(err) });
            }
        }
        else {
            log('INFO', 'constitution_not_found', { path: jsonPath, action: 'no_protection' });
        }
        this.initialized = true;
    }
    /**
     * 设置执行模式。
     * warn: 仅记录日志，不阻止操作
     * enforce: 阻止操作并抛出错误
     * off: 完全绕过
     */
    setEnforcementMode(mode) {
        const previous = this.mode;
        this.mode = mode;
        this.emit('constitution.mode_changed', { mode, previous });
        log('INFO', 'constitution_mode', { mode, previous });
    }
    /**
     * 检查写入目标路径是否合规。
     * 返回 ConstitutionCheck，调用方据此决定是否放行。
     */
    checkWrite(absolutePath) {
        if (this.mode === 'off' || !this.initialized || !this.paths.hasRules) {
            return { allowed: true };
        }
        const match = this.paths.isProtected(absolutePath);
        if (!match) {
            return { allowed: true };
        }
        const violation = {
            path: absolutePath,
            pattern: match.pattern,
            reason: match.reason,
            severity: 'error',
            layer: match.layer,
        };
        this.emit('constitution.violation', {
            path: absolutePath,
            pattern: match.pattern,
            reason: match.reason,
            layer: match.layer,
            mode: this.mode,
        });
        if (this.mode === 'warn') {
            log('WARN', 'constitution_violation_warn', {
                path: absolutePath,
                pattern: match.pattern,
                reason: match.reason,
                layer: match.layer,
            });
            return { allowed: true, violation };
        }
        log('ERROR', 'constitution_violation_blocked', {
            path: absolutePath,
            pattern: match.pattern,
            reason: match.reason,
            layer: match.layer,
        });
        return { allowed: false, violation };
    }
    // ──── 事件（简易版，不依赖 EventBus 以避免循环依赖） ────
    on(event, listener) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(listener);
        return () => {
            this.listeners.get(event)?.delete(listener);
        };
    }
    emit(event, payload) {
        this.listeners.get(event)?.forEach((fn) => {
            try {
                fn(payload);
            }
            catch {
                /* ignore */
            }
        });
    }
}
