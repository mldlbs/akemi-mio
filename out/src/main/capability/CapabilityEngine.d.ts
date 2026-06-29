import { ConstitutionEngine } from '../constitution/ConstitutionEngine';
import type { CapabilityAction, CapabilityDecision, CapabilityRequest, CapabilityToken, AuditEntry } from './types';
/**
 * DelegationChain — 令牌委托链管理
 *
 * 维护令牌之间的父子关系，确保子令牌的权限不会超过父令牌。
 * 支持递归吊销整条链。
 */
export declare class DelegationChain {
    private parents;
    private children;
    registerChild(parentId: string, childId: string): void;
    verifyChain(tokenId: string, revokedTokens: Set<string>): boolean;
    revokeAll(tokenId: string, revokedTokens: Set<string>): string[];
}
/**
 * CapabilityEngine — 能力沙箱授权引擎
 *
 * 核心授权决策器。集成 ConstitutionEngine 用于文件写入检查。
 * 提供令牌发放、吊销、委托和快速路径检查。
 */
export declare class CapabilityEngine {
    private tokens;
    private revokedTokens;
    private auditLog;
    private readonly maxAuditLogSize;
    private delegationChain;
    private enforcementMode;
    private constitutionEngine;
    constructor(modes?: {
        enforcement?: 'off' | 'warn' | 'enforce';
    });
    setConstitutionEngine(engine: ConstitutionEngine): void;
    setEnforcementMode(mode: 'off' | 'warn' | 'enforce'): void;
    getEnforcementMode(): string;
    requestToken(request: CapabilityRequest): CapabilityDecision;
    checkCallAllowed(action: CapabilityAction, resource?: string, caller?: string): boolean;
    revokeToken(tokenId: string): void;
    revokeChain(tokenId: string): string[];
    delegateToken(parentTokenId: string, childRequest: CapabilityRequest): CapabilityToken | null;
    getAuditLog(): AuditEntry[];
    clearAuditLog(): void;
    private issueToken;
    private getDefaultCapabilities;
    private recordAudit;
}
