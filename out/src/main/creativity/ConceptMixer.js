import { resolveRandom } from '../utils/random';
/**
 * ConceptMixer — 创造力核心：旧概念随机重组产生新想法
 *
 * 人类创造力 ≈ 已有概念的重新组合
 * 输入来源越多、越多样，组合越新颖
 *
 * v2 改动：mix() 接受 strategy 参数，在配对前约束组合空间。
 * strategy 决定了允许哪些 type 配对，而不只是事后评分。
 * 参见策略定义：Strategy = 'stable' | 'explore' | 'signal'
 */
export class ConceptMixer {
    constructor(seed) {
        this.rng = resolveRandom(seed);
    }
    /**
     * 将所有来源两两配对并打分，返回前 N 个最有潜力的组合
     * @param exploredPairs 已探索过的 pair key 列表（"A|B" 格式，已排序），用于降权
     * @param strategy 策略约束：stable/explore/signal，默认为 'explore'
     *   策略决定哪些 type 配对被允许、评分权重如何调整。
     */
    mix(sources, maxCombos = 10, exploredPairs = [], strategy = 'explore') {
        if (sources.length < 2)
            return [];
        const exploredSet = new Set(exploredPairs);
        // 先按策略约束过滤允许的配对
        const allowed = this.generatePairs(sources, strategy);
        const scored = allowed.map(([a, b]) => this.scorePair(a, b, sources, exploredSet, strategy));
        const sorted = scored.sort((a, b) => b.score - a.score);
        return sorted.slice(0, maxCombos);
    }
    /**
     * 按策略约束生成配对 — 核心改动：
     * - stable:   只同类型配对（去掉 novelty bonus 主导的跨类型噪声）
     * - explore:  跨类型优先，保留现有的多样性行为
     * - signal:   强制包含 provocation/insight/trend，限制纯知识配对
     */
    generatePairs(sources, strategy) {
        const pairs = [];
        if (strategy === 'stable') {
            // 只同类型配对，去掉外源随机扰动
            for (let i = 0; i < sources.length; i++) {
                for (let j = i + 1; j < sources.length; j++) {
                    if (sources[i].type === sources[j].type) {
                        pairs.push([sources[i], sources[j]]);
                    }
                }
            }
        }
        else if (strategy === 'signal') {
            // 至少一个来源必须是 provocation/insight/failure
            const signalTypes = new Set(['provocation', 'insight', 'failure']);
            for (let i = 0; i < sources.length; i++) {
                for (let j = i + 1; j < sources.length; j++) {
                    if (signalTypes.has(sources[i].type) || signalTypes.has(sources[j].type)) {
                        pairs.push([sources[i], sources[j]]);
                    }
                }
            }
        }
        else {
            // explore: 跨类型优先（原行为），但也允许同类型
            for (let i = 0; i < sources.length; i++) {
                for (let j = i + 1; j < sources.length; j++) {
                    if (sources[i].type !== sources[j].type) {
                        pairs.push([sources[i], sources[j]]);
                    }
                }
            }
            // 补充少量同类型（不超过总配对 20%）
            const sameTypeCount = Math.max(0, Math.floor(sources.length * 0.2));
            let added = 0;
            for (let i = 0; i < sources.length && added < sameTypeCount; i++) {
                for (let j = i + 1; j < sources.length && added < sameTypeCount; j++) {
                    if (sources[i].type === sources[j].type) {
                        pairs.push([sources[i], sources[j]]);
                        added++;
                    }
                }
            }
        }
        return pairs;
    }
    scorePair(a, b, allSources, exploredSet = new Set(), strategy = 'explore') {
        // 按策略调整基础评分权重
        let typeBonus;
        switch (strategy) {
            case 'stable':
                typeBonus = 30; // 同类型也有足够权重
                break;
            case 'signal':
                typeBonus = 35; // 信号来源 + 知识源的配对
                break;
            default:
                typeBonus = a.type === b.type ? 10 : 40;
        }
        const weightProduct = a.weight * b.weight * 0.3;
        const noveltyBonus = this.calculateNoveltyBonus(a, b, allSources, strategy);
        // 策略感知的随机扰动
        const perturbation = strategy === 'stable' ? this.rng() * 10 : this.rng() * 20;
        // 已探索过的配对降权
        const pairKey = [a.name, b.name].sort().join('|');
        const explorationPenalty = exploredSet.has(pairKey) ? 15 : 0;
        const score = Math.round(typeBonus + weightProduct + noveltyBonus + perturbation - explorationPenalty);
        const description = this.describeCombo(a.name, b.name, a.type, b.type);
        const combo = {
            id: `combo_${Date.now()}_${this.rng().toString(36).slice(2, 6)}`,
            sources: [a.name, b.name],
            description,
            createdAt: Date.now(),
        };
        return { combo, score };
    }
    calculateNoveltyBonus(a, b, allSources, strategy = 'explore') {
        // stable: novelty bonus 大幅压降，消除 novelty bias
        if (strategy === 'stable') {
            return a.type === b.type ? 3 : 8;
        }
        // signal: 偏向 signal 来源
        if (strategy === 'signal') {
            const signalTypes = new Set(['provocation', 'insight', 'failure']);
            const hasSignal = signalTypes.has(a.type) || signalTypes.has(b.type);
            return hasSignal ? 25 : 5;
        }
        // explore: 原行为不变
        let bonus = a.type === b.type ? 5 : 20;
        const rareTypes = ['failure', 'random', 'provocation', 'insight'];
        if (rareTypes.includes(a.type))
            bonus += 10;
        if (rareTypes.includes(b.type))
            bonus += 10;
        bonus += Math.round(Math.abs(a.weight - b.weight) * 20);
        const sameTypeCount = allSources.filter((s) => s.type === a.type || s.type === b.type).length;
        if (sameTypeCount <= 2)
            bonus += 15;
        return bonus;
    }
    describeCombo(nameA, nameB, typeA, typeB) {
        const comboType = `${typeA} × ${typeB}`;
        const combos = {
            'knowledge × knowledge': `将「${nameA}」与「${nameB}」两种知识领域融合，形成跨领域新概念`,
            'knowledge × behavior': `将「${nameA}」的知识与「${nameB}」的行为模式结合`,
            'knowledge × insight': `用「${nameA}」的知识重新解读「${nameB}」的洞察`,
            'knowledge × failure': `从「${nameB}」的失败中寻找「${nameA}」的未被发现的价值`,
            'knowledge × random': `让「${nameA}」受到「${nameB}」的随机扰动产生变异`,
            'behavior × behavior': `合并「${nameA}」与「${nameB}」两种行为模式`,
            'behavior × insight': `用「${nameB}」的洞察解释「${nameA}」的行为`,
            'behavior × failure': `「${nameA}」的行为方式能否避免「${nameB}」的失败`,
            'behavior × random': `将「${nameA}」的行为方式与随机元素「${nameB}」杂交`,
            'insight × insight': `将两个洞察「${nameA}」与「${nameB}」放在一起，产生更深层的推论`,
            'insight × failure': `「${nameB}」的失败是否源于「${nameA}」所揭示的问题`,
            'insight × random': `用随机元素「${nameB}」扰动既有洞察「${nameA}」`,
            'failure × failure': `将「${nameA}」和「${nameB}」两种失败模式组合，避免重蹈覆辙`,
            'failure × random': `「${nameA}」的失败 + 「${nameB}」的随机扰动 = 全新方向`,
        };
        return combos[comboType] || `概念重组: ${nameA} × ${nameB}`;
    }
    /**
     * 随机抽取一组来源（温度越高，越可能选中低权重来源）
     */
    pickRandomSources(sources, temperature, minCount = 3) {
        const weighted = sources.map((s) => ({
            source: s,
            weight: s.weight * (0.5 + this.rng() * temperature),
        }));
        const sorted = weighted.sort((a, b) => b.weight - a.weight);
        const count = Math.min(sorted.length, Math.max(minCount, Math.floor(sorted.length * (0.3 + this.rng() * 0.5))));
        return sorted.slice(0, count).map((w) => w.source);
    }
}
