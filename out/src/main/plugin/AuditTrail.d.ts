export interface AuditEntry {
    id: string;
    timestamp: number;
    source: 'agent' | 'plugin' | 'user' | 'evolution' | 'system';
    action: 'tool_call' | 'file_write' | 'file_read' | 'command' | 'permission_change' | 'plugin_load' | 'plugin_unload';
    target: string;
    pluginName?: string;
    toolName?: string;
    details: Record<string, any>;
    allowed: boolean;
    duration?: number;
    reason?: string;
}
export declare class AuditTrail {
    record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void;
    query(filter?: {
        source?: string;
        action?: string;
        limit?: number;
    }): AuditEntry[];
    getRecent(limit?: number): AuditEntry[];
    getBySource(source: string, limit?: number): AuditEntry[];
    getStats(): {
        total: number;
        bySource: Record<string, number>;
        byAction: Record<string, number>;
    };
    private prune;
}
