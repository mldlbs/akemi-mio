const STALLED_DAYS = 14;
const WARNING_DAYS = 7;
export class StalledGoalDetector {
    detect(ctx) {
        const results = [];
        const now = Date.now();
        for (const plan of ctx.plans) {
            const daysSinceUpdate = (now - plan.updatedAt) / (24 * 60 * 60 * 1000);
            const daysSinceCreation = (now - plan.createdAt) / (24 * 60 * 60 * 1000);
            if (plan.status === 'active' && daysSinceUpdate >= STALLED_DAYS) {
                const doneSteps = plan.steps.filter(s => s.status === 'done').length;
                const totalSteps = plan.steps.length;
                results.push({
                    detector: 'StalledGoalDetector',
                    type: 'stalled_goal',
                    severity: 'high',
                    title: `计划「${plan.title}」已停滞`,
                    description: `已创建 ${Math.round(daysSinceCreation)} 天，${Math.round(daysSinceUpdate)} 天未推进。进度 ${doneSteps}/${totalSteps}`,
                    evidence: [
                        `计划: ${plan.title}`,
                        `已停滞 ${Math.round(daysSinceUpdate)} 天`,
                        `进度: ${doneSteps}/${totalSteps}`
                    ],
                    novelty: 60,
                    impact: 75,
                    actionability: 85
                });
            }
            else if (plan.status === 'active' && daysSinceUpdate >= WARNING_DAYS) {
                results.push({
                    detector: 'StalledGoalDetector',
                    type: 'stalled_goal',
                    severity: 'medium',
                    title: `计划「${plan.title}」进展缓慢`,
                    description: `${Math.round(daysSinceUpdate)} 天未更新`,
                    evidence: [`计划: ${plan.title}`, `${Math.round(daysSinceUpdate)} 天未更新`],
                    novelty: 35,
                    impact: 50,
                    actionability: 70
                });
            }
        }
        const stalledPlans = ctx.plans.filter(p => p.status === 'active');
        const allStalled = stalledPlans.every(p => (now - p.updatedAt) > WARNING_DAYS * 24 * 60 * 60 * 1000);
        if (stalledPlans.length >= 2 && allStalled) {
            results.push({
                detector: 'StalledGoalDetector',
                type: 'stalled_goal',
                severity: 'medium',
                title: '所有开发计划全面停滞',
                description: `${stalledPlans.length} 个活跃计划均已超过 ${WARNING_DAYS} 天未更新，可能遇到了系统性障碍`,
                evidence: [`${stalledPlans.length} 个计划停滞`, ...stalledPlans.map(p => p.title)],
                novelty: 70,
                impact: 65,
                actionability: 60
            });
        }
        return results;
    }
}
