/**
 * InsightService 定时分析 handler。
 * 在 handler 内调用服务的 tick() 方法驱动检查循环。
 */
export const insightAnalysisHandler = async (task, context) => {
    const svc = context.services.insightService;
    if (!svc) {
        throw new Error('insightAnalysisHandler: insightService not injected');
    }
    svc.tick();
    return { ticked: true };
};
