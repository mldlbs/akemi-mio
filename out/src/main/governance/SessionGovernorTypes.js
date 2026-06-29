/**
 * SessionGovernor 核心类型定义
 *
 * 会话级健康管理、状态迁移、恢复框架的类型系统。
 */
export const HEALTH_THRESHOLDS = {
    HEALTHY: [95, 100],
    NORMAL: [70, 95],
    RISKY: [50, 70],
    CRITICAL: [30, 50],
    CORRUPTED: [0, 30],
};
export function getHealthLevel(score) {
    if (score >= 95)
        return 'HEALTHY';
    if (score >= 70)
        return 'NORMAL';
    if (score >= 50)
        return 'RISKY';
    if (score >= 30)
        return 'CRITICAL';
    return 'CORRUPTED';
}
export const RECOVERY_ACTIONS = {
    1: { level: 1, name: 'context_compress', description: '上下文压缩，清理 orphan tool_call' },
    2: { level: 2, name: 'inject_correction', description: '注入纠偏提示，引导模型行为' },
    3: { level: 3, name: 'model_switch', description: '切换模型，降级到轻量模型' },
    4: { level: 4, name: 'tool_downgrade', description: '工具降级，只允许只读操作' },
    5: { level: 5, name: 'clear_context', description: '清空上下文窗口，保留 sessionId' },
    6: { level: 6, name: 'rebuild_session', description: '重建会话，继承记忆' },
    7: { level: 7, name: 'safe_mode', description: '进入安全模式，只接受有限指令' },
    8: { level: 8, name: 'hibernation', description: '进入休眠，等待用户主动唤醒' },
};
export const TRANSITION_RULES = [
    {
        from: ['RUNNING'],
        to: 'DEGRADED',
        condition: (score) => score < 70,
        reason: '健康分低于 70，进入降级状态',
    },
    {
        from: ['RUNNING'],
        to: 'FATAL',
        condition: (_score, failures) => failures >= 33,
        reason: '连续 33 次以上失败，不可恢复',
    },
    {
        from: ['DEGRADED'],
        to: 'RECOVERING',
        condition: (score) => score < 50,
        reason: '健康分低于 50，主动恢复',
    },
    {
        from: ['DEGRADED'],
        to: 'RUNNING',
        condition: (score) => score > 75,
        reason: '健康分回升超过 75，恢复正常',
    },
    {
        from: ['RECOVERING'],
        to: 'SAFE_MODE',
        condition: (score) => score < 30,
        reason: '恢复失败，进入安全模式',
    },
    {
        from: ['RECOVERING'],
        to: 'RUNNING',
        condition: (score) => score > 80,
        reason: '恢复成功，验证通过',
    },
    {
        from: ['SAFE_MODE'],
        to: 'REBUILDING',
        condition: (score) => score < 20,
        reason: '安全模式下仍持续恶化，重建会话',
    },
    {
        from: ['SAFE_MODE'],
        to: 'RUNNING',
        condition: (score) => score > 75,
        reason: '降级后功能子集正常运转',
    },
    {
        from: ['REBUILDING'],
        to: 'RUNNING',
        condition: () => true,
        reason: '会话重建完成',
    },
    {
        from: ['REBUILDING', 'SAFE_MODE', 'RECOVERING', 'DEGRADED', 'RUNNING'],
        to: 'FATAL',
        condition: (_score, failures) => failures >= 50,
        reason: '连续 50 次失败，标记为不可恢复',
    },
];
