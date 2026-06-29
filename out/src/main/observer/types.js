// ============================================================
// 运行时配置
// ============================================================
export const DEFAULT_EVOLUTION_WEIGHTS = {
    alpha: 0.3,
    beta: 0.2,
    gamma: 0.15,
    delta: 0.15,
    epsilon: 0.2,
};
export const DEFAULT_EVOLUTION_THRESHOLDS = {
    writingGate: 0.7,
    trendMinScore: 0.3,
};
export const DEFAULT_EVOLUTION_PARAMS = {
    weights: DEFAULT_EVOLUTION_WEIGHTS,
    thresholds: DEFAULT_EVOLUTION_THRESHOLDS,
    version: 1,
    updatedAt: new Date(0).toISOString(),
};
export const WRITING_MODE_LABELS = {
    neutral: '客观纪实',
    analytical: '深度分析',
    creative: '叙事思辨',
};
export const INSIGHT_SECTION_TITLES = {
    1: '发生了什么',
    2: '背后结构',
    3: '不同视角',
    4: '我的理解',
    5: '未来推演',
};
