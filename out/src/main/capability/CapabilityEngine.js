import { log } from '../logger/Logger';
import { DEFAULT_CAPABILITIES } from './CapabilityDefaults';
/**
 * DelegationChain — 令牌委托链管理
 *
 * 维护令牌之间的父子关系，确保子令牌的权限不会超过父令牌。
 * 支持递归吊销整条链。
 */
export class DelegationChain {
    constructor() {
        this.parents = new Map();
        this.children = new Map();
    }
    registerChild(parentId, childId) {
        this.parents.set(childId, parentId);
        if (!this.children.has(parentId)) {
            this.children.set(parentId, new Set());
        }
        this.children.get(parentId).add(childId);
    }
    verifyChain(tokenId, revokedTokens) {
        let current = tokenId;
        const visited = new Set();
        while (current) {
            if (visited.has(current))
                return false;
            visited.add(current);
            if (revokedTokens.has(current))
                return false;
            const parent = this.parents.get(current);
            if (!parent)
                break;
            current = parent;
        }
        return true;
    }
    revokeAll(tokenId, revokedTokens) {
        const all = [tokenId];
        const toVisit = [tokenId];
        while (toVisit.length > 0) {
            const current = toVisit.pop();
            if (revokedTokens.has(current))
                continue;
            revokedTokens.add(current);
            const kids = this.children.get(current);
            if (kids) {
                for (const kid of kids) {
                    all.push(kid);
                    toVisit.push(kid);
                }
            }
        }
        return all;
    }
}
/**
 * CapabilityEngine — 能力沙箱授权引擎
 *
 * 核心授权决策器。集成 ConstitutionEngine 用于文件写入检查。
 * 提供令牌发放、吊销、委托和快速路径检查。
 */
export class CapabilityEngine {
    constructor(modes) {
        this.tokens = new Map();
        this.revokedTokens = new Set();
        this.auditLog = [];
        this.maxAuditLogSize = 1000;
        this.delegationChain = new DelegationChain();
        this.enforcementMode = 'warn';
        this.constitutionEngine = null;
        if (modes?.enforcement) {
            this.enforcementMode = modes.enforcement;
        }
    }
    setConstitutionEngine(engine) {
        this.constitutionEngine = engine;
    }
    setEnforcementMode(mode) {
        this.enforcementMode = mode;
    }
    getEnforcementMode() {
        return this.enforcementMode;
    }
    // ==================== 令牌管理 ====================
    requestToken(request) {
        const allowed = this.getDefaultCapabilities(request.context.caller);
        const granted = allowed.length === 0 || allowed.includes(request.action);
        const decision = {
            granted: this.enforcementMode === 'off' ? true : granted,
            reason: granted ? undefined : `Caller "${request.context.caller}" not allowed: ${request.action}`,
            auditEntry: {
                requestId: request.context.requestId,
                action: request.action,
                resource: request.resource,
                caller: request.context.caller,
                granted: this.enforcementMode === 'off' ? true : granted,
                reason: granted ? undefined : `Not in default capabilities for ${request.context.caller}`,
                timestamp: Date.now(),
            },
        };
        if (granted && this.enforcementMode !== 'off') {
            decision.token = this.issueToken(request.action, request.resource, request.context.caller);
        }
        this.recordAudit(decision.auditEntry);
        return decision;
    }
    checkCallAllowed(action, resource, caller) {
        if (this.enforcementMode === 'off')
            return true;
        if (action === 'file.write' && this.constitutionEngine && resource) {
            const check = this.constitutionEngine.checkWrite(resource);
            if (!check.allowed) {
                log('WARN', 'capability.constitution_denied', { caller, resource });
                if (this.enforcementMode === 'enforce')
                    return false;
            }
        }
        const allowed = this.getDefaultCapabilities(caller || 'unknown');
        const result = allowed.length === 0 || allowed.includes(action);
        if (!result && this.enforcementMode === 'warn') {
            log('WARN', 'capability.denied', { caller, action, resource });
        }
        return result;
    }
    revokeToken(tokenId) {
        this.revokedTokens.add(tokenId);
        this.tokens.delete(tokenId);
    }
    revokeChain(tokenId) {
        return this.delegationChain.revokeAll(tokenId, this.revokedTokens);
    }
    delegateToken(parentTokenId, childRequest) {
        const parent = this.tokens.get(parentTokenId);
        if (!parent)
            return null;
        if (this.revokedTokens.has(parentTokenId))
            return null;
        if (childRequest.action !== parent.action)
            return null;
        if (parent.resource && childRequest.resource && !childRequest.resource.startsWith(parent.resource)) {
            return null;
        }
        const child = this.issueToken(childRequest.action, childRequest.resource, childRequest.context.caller);
        child.delegatedFrom = parentTokenId;
        this.delegationChain.registerChild(parentTokenId, child.id);
        return child;
    }
    getAuditLog() {
        return [...this.auditLog];
    }
    clearAuditLog() {
        this.auditLog = [];
    }
    // ==================== 内部方法 ====================
    issueToken(action, resource, caller) {
        const token = {
            id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            action,
            resource,
            issuedBy: caller || 'unknown',
            issuedAt: Date.now(),
        };
        this.tokens.set(token.id, token);
        return token;
    }
    getDefaultCapabilities(caller) {
        return DEFAULT_CAPABILITIES[caller] || DEFAULT_CAPABILITIES['unknown'];
    }
    recordAudit(entry) {
        this.auditLog.push(entry);
        if (this.auditLog.length > this.maxAuditLogSize) {
            this.auditLog = this.auditLog.slice(-this.maxAuditLogSize);
        }
    }
}
