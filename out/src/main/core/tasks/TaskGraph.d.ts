/**
 * TaskGraph — 任务依赖图引擎。
 *
 * 职责仅限于：
 * 1. 管理任务间的依赖关系（DAG）
 * 2. 拓扑排序
 * 3. 环检测
 *
 * 不参与调度决策、不计算效用、不选择任务。
 */
/** 任务图节点元数据 — 纯结构描述，不含效用/风险 */
export interface TaskGraphMeta {
    dependsOn: string[];
    blocks: string[];
    produces: string[];
}
export declare class TaskGraph {
    /** 节点列表 */
    private nodes;
    /** 前驱边: predecessor -> Set<successor> (predecessor blocks successor) */
    private forward;
    /** 后继边: successor -> Set<predecessor> (successor depends on predecessor) */
    private reverse;
    /** 待处理边: 用于处理引用未添加节点的场景 */
    private pendingEdges;
    addNode(taskId: string, meta: TaskGraphMeta): void;
    removeNode(taskId: string): void;
    /** 添加依赖边: from 阻塞 to (to 依赖 from) */
    addEdge(from: string, to: string): void;
    /** 依赖此任务的任务列表（谁依赖我） */
    getDependents(taskId: string): string[];
    /** 被此任务阻塞的任务列表（我依赖谁） */
    getBlockedBy(taskId: string): string[];
    /** 无依赖的根节点 */
    getRootNodes(): string[];
    /** 从 taskId 出发可达的所有节点（包含自身） */
    getSubgraph(taskId: string): string[];
    /**
     * Kahn 拓扑排序。
     * 有环返回空数组。
     */
    topologicalSort(): string[];
    /**
     * 环检测。
     * 有环返回一个环路径，无环返回 null。
     */
    detectCycle(): string[] | null;
    /** 图中节点数量 */
    get size(): number;
    /** 获取节点元数据 */
    getMeta(taskId: string): TaskGraphMeta | undefined;
    /** 获取所有节点 ID */
    getAllNodes(): string[];
    /** 获取所有边的描述 */
    getEdges(): Array<{
        from: string;
        to: string;
    }>;
}
