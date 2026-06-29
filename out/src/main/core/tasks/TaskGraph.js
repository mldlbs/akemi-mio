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
export class TaskGraph {
    constructor() {
        /** 节点列表 */
        this.nodes = new Map();
        /** 前驱边: predecessor -> Set<successor> (predecessor blocks successor) */
        this.forward = new Map();
        /** 后继边: successor -> Set<predecessor> (successor depends on predecessor) */
        this.reverse = new Map();
        /** 待处理边: 用于处理引用未添加节点的场景 */
        this.pendingEdges = [];
    }
    addNode(taskId, meta) {
        if (this.nodes.has(taskId))
            return;
        this.nodes.set(taskId, { taskId, meta });
        if (!this.forward.has(taskId))
            this.forward.set(taskId, new Set());
        if (!this.reverse.has(taskId))
            this.reverse.set(taskId, new Set());
        // 解析依赖边
        for (const dep of meta.dependsOn) {
            this.addEdge(dep, taskId);
        }
        // 阻塞关系：此任务完成后被阻塞者才能开始
        for (const blocked of meta.blocks) {
            this.addEdge(taskId, blocked);
        }
        // 重放 pending 边
        const replay = this.pendingEdges.filter((e) => e.from === taskId || e.to === taskId);
        this.pendingEdges = this.pendingEdges.filter((e) => e.from !== taskId && e.to !== taskId);
        for (const { from, to } of replay) {
            if (this.nodes.has(from) && this.nodes.has(to)) {
                this.forward.get(from).add(to);
                this.reverse.get(to).add(from);
            }
        }
        // 扫描已存在的节点：它们可能引用了这个新节点
        for (const [existingId, existing] of this.nodes) {
            if (existingId === taskId)
                continue;
            if (existing.meta.dependsOn.includes(taskId)) {
                this.forward.get(taskId).add(existingId);
                this.reverse.get(existingId).add(taskId);
            }
            if (existing.meta.blocks.includes(taskId)) {
                this.forward.get(existingId).add(taskId);
                this.reverse.get(taskId).add(existingId);
            }
        }
    }
    removeNode(taskId) {
        if (!this.nodes.has(taskId))
            return;
        // Remove all edges involving this node
        const fwd = this.forward.get(taskId);
        if (fwd) {
            for (const successor of fwd) {
                this.reverse.get(successor)?.delete(taskId);
            }
        }
        const rev = this.reverse.get(taskId);
        if (rev) {
            for (const predecessor of rev) {
                this.forward.get(predecessor)?.delete(taskId);
            }
        }
        this.forward.delete(taskId);
        this.reverse.delete(taskId);
        this.nodes.delete(taskId);
        // Remove from pending
        this.pendingEdges = this.pendingEdges.filter((e) => e.from !== taskId && e.to !== taskId);
    }
    /** 添加依赖边: from 阻塞 to (to 依赖 from) */
    addEdge(from, to) {
        if (!this.nodes.has(from) || !this.nodes.has(to)) {
            // 节点暂不存在，先记录
            this.pendingEdges.push({ from, to });
            return;
        }
        this.forward.get(from).add(to);
        this.reverse.get(to).add(from);
    }
    /** 依赖此任务的任务列表（谁依赖我） */
    getDependents(taskId) {
        return Array.from(this.forward.get(taskId) ?? []);
    }
    /** 被此任务阻塞的任务列表（我依赖谁） */
    getBlockedBy(taskId) {
        return Array.from(this.reverse.get(taskId) ?? []);
    }
    /** 无依赖的根节点 */
    getRootNodes() {
        const roots = [];
        for (const [id] of this.nodes) {
            const deps = this.reverse.get(id);
            if (!deps || deps.size === 0) {
                roots.push(id);
            }
        }
        return roots;
    }
    /** 从 taskId 出发可达的所有节点（包含自身） */
    getSubgraph(taskId) {
        const visited = new Set();
        const queue = [taskId];
        while (queue.length > 0) {
            const current = queue.shift();
            if (visited.has(current))
                continue;
            visited.add(current);
            const fwd = this.forward.get(current);
            if (fwd) {
                for (const next of fwd) {
                    if (!visited.has(next))
                        queue.push(next);
                }
            }
        }
        return Array.from(visited);
    }
    /**
     * Kahn 拓扑排序。
     * 有环返回空数组。
     */
    topologicalSort() {
        const inDegree = new Map();
        for (const [id] of this.nodes) {
            inDegree.set(id, 0);
        }
        for (const [, successors] of this.forward) {
            for (const s of successors) {
                inDegree.set(s, (inDegree.get(s) ?? 0) + 1);
            }
        }
        const queue = [];
        for (const [id, deg] of inDegree) {
            if (deg === 0)
                queue.push(id);
        }
        const result = [];
        while (queue.length > 0) {
            const current = queue.shift();
            result.push(current);
            const fwd = this.forward.get(current);
            if (fwd) {
                for (const next of fwd) {
                    const newDeg = (inDegree.get(next) ?? 1) - 1;
                    inDegree.set(next, newDeg);
                    if (newDeg === 0)
                        queue.push(next);
                }
            }
        }
        if (result.length !== this.nodes.size)
            return []; // cycle detected
        return result;
    }
    /**
     * 环检测。
     * 有环返回一个环路径，无环返回 null。
     */
    detectCycle() {
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = new Map();
        for (const [id] of this.nodes)
            color.set(id, WHITE);
        const parent = new Map();
        const dfs = (u) => {
            color.set(u, GRAY);
            const fwd = this.forward.get(u);
            if (fwd) {
                for (const v of fwd) {
                    if (color.get(v) === GRAY) {
                        // Found cycle: reconstruct path v -> ... -> u -> v
                        const cycle = [v, u];
                        let cur = u;
                        while (cur !== v && parent.has(cur)) {
                            cur = parent.get(cur);
                            if (cur !== v)
                                cycle.push(cur);
                        }
                        cycle.push(v);
                        return cycle.reverse();
                    }
                    if (color.get(v) === WHITE) {
                        parent.set(v, u);
                        const result = dfs(v);
                        if (result)
                            return result;
                    }
                }
            }
            color.set(u, BLACK);
            return null;
        };
        for (const [id] of this.nodes) {
            if (color.get(id) === WHITE) {
                parent.set(id, null);
                const cycle = dfs(id);
                if (cycle)
                    return cycle;
            }
        }
        return null;
    }
    /** 图中节点数量 */
    get size() {
        return this.nodes.size;
    }
    /** 获取节点元数据 */
    getMeta(taskId) {
        return this.nodes.get(taskId)?.meta;
    }
    /** 获取所有节点 ID */
    getAllNodes() {
        return Array.from(this.nodes.keys());
    }
    /** 获取所有边的描述 */
    getEdges() {
        const edges = [];
        for (const [from, successors] of this.forward) {
            for (const to of successors) {
                edges.push({ from, to });
            }
        }
        return edges;
    }
}
