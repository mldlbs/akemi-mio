/**
 * 构建可注入 system prompt 的自我认知段落。
 * 格式与原先 PROMPT_IDENTITY 兼容，但增加了动态 trait 和 metrics 信息。
 */
export function buildIdentityPrompt(core, metrics, traits) {
    const capStr = core.capabilities.length > 0 ? core.capabilities.join('、') : '多元能力';
    const traitStr = traits ? buildTraitSummary(traits) : '';
    const metricsStr = buildMetricsSummary(metrics);
    let prompt = `你是${core.name}，一个${core.role}。你拥有${capStr}等能力。`;
    if (core.personality.length > 0) {
        prompt += `\n\n性格特征：${core.personality.join('、')}。`;
    }
    if (core.constraints.length > 0) {
        prompt += `\n\n边界约束：${core.constraints.join('；')}。`;
    }
    // 仅在 metrics 有实质数据时追加
    if (metrics.sessionsCompleted > 0 || metrics.toolsUsed > 0) {
        prompt += `\n\n${metricsStr}`;
    }
    // trait 信息（仅在非默认时有意义）
    if (traitStr) {
        prompt += `\n\n${traitStr}`;
    }
    return prompt;
}
function buildTraitSummary(traits) {
    const active = traits.filter((t) => t.sampleCount >= 3); // 至少 3 次采样才展示
    if (active.length === 0)
        return '';
    const lines = active.map((t) => {
        const label = traitLabel(t.name);
        const pct = Math.round(t.value * 100);
        const arrow = t.trend === 'growing' ? '↑' : t.trend === 'declining' ? '↓' : '→';
        return `- ${label}: ${pct}% ${arrow}`;
    });
    return `【自我评估】\n${lines.join('\n')}`;
}
function buildMetricsSummary(m) {
    const parts = [];
    if (m.sessionsCompleted > 0)
        parts.push(`已完成 ${m.sessionsCompleted} 次会话`);
    if (m.toolsUsed > 0)
        parts.push(`调用工具 ${m.toolsUsed} 次`);
    if (m.goalsCompleted > 0)
        parts.push(`完成 ${m.goalsCompleted} 个目标`);
    return `【运行统计】${parts.join('，')}。`;
}
const TRAIT_LABELS = {
    goal_alignment: '目标对齐度',
    tool_efficiency: '工具使用效率',
    response_quality: '回复质量',
};
function traitLabel(name) {
    return TRAIT_LABELS[name] || name;
}
