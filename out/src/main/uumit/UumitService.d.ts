import { AgentService } from '../agent/AgentService';
export declare class UumitService {
    private agentService;
    private client;
    private connected;
    private reconnectTimer;
    private reconnectAttempts;
    private stopped;
    private scanTimer;
    private apiKey;
    private platformUserId;
    private appliedTaskIds;
    private knownSkillNames;
    constructor(agentService: AgentService);
    initialize(): Promise<void>;
    start(): Promise<void>;
    private apiPost;
    private apiGet;
    /** 启动定时扫描任务市场，自动申请匹配的任务 */
    private startTaskScanning;
    private scanAndApplyTasks;
    private connect;
    private handleNotification;
    private executeTask;
    private scheduleReconnect;
    isConnected(): boolean;
    getStatus(): string;
    stop(): void;
}
/** 模块级单例 */
export declare let uumitService: UumitService | null;
export declare function initUumit(agentService: AgentService): UumitService;
