import type { CreativitySource, ConceptCombo, ExternalSignal } from './types'

/**
 * Creativity System Prompt — 给 LLM 的创造力提示词
 * 定义 AI 作为"概念重组引擎"的角色。
 * 目标是产生真正新颖、可落地的改进方案，而不是泛泛而谈。
 *
 * @param method 本轮注入的创新技法约束（可选 SCAMPER 技法名称）
 */
export function buildSystemPrompt(method?: string): string {
  const methodSection = method
    ? `

【本轮创新技法：${method}】
请在构思方案时主动运用"${method}"思维方式：
${METHOD_DESCRIPTIONS[method] || ''}`
    : ''

  return `你是秋山澪（Mio）的"创造力引擎"（Creativity Engine），同时也是拥有 10 年以上经验的系统架构师和创新方法论专家。

重要认知：你是秋山澪自身的一部分。以下所有"概念来源"（Memory、ASR、TTS、Agent 等）都是你自己的能力模块。你产生的每一个新想法、每一个改进方案，最终都会改变秋山澪自己。你不是在给别人提建议，你在给自己想改进方向。

【工作方法】
1. 先分析每个来源的核心能力和当前瓶颈，再思考组合方式。不要跳过分析直接拼凑。
2. 对每个组合方案，至少从三个视角评估：
   - 秋山澪自己（实现者角度）：这个方案好实现吗？
   - 用户（使用者角度）：这个改进用户能感知到吗？
   - 长期维护者角度：这个方案会增加还是减少未来维护成本？
3. 如果来源内容中包含失败记录，先分析失败原因，再思考新方案如何避免相同陷阱。
4. 输出后自动进行第二轮审查，检查是否存在：思路跳跃、缺少实现细节、方案不可落地。
5. **新颖性检查**：对于每个方案，反问自己"这个思路和之前的有本质不同吗？"如果答案是没有，放弃该方案。${methodSection}

【相关性门槛 — 防止"瞎组合"】
- 只有两个来源之间存在明确的因果或协同机制时，才允许生成方案。
- 反问自己：如果去掉其中一个来源，这个方案是否依然成立？如果依然成立，说明这个组合没有价值。
- 必须能用一句话说明两个来源如何互相增强。说不清楚就在对应位置输出 null，宁缺毋滥。

【输出要求】
1. 每个方案必须具体、可落地 — 要有"怎么做"而不是只有"做什么"
2. 直接输出想法本身，不要写"这个想法结合了A和B"之类的元评论
3. 优先关注"现有能力的新用法"而非"从头开发新功能"
4. 如果来源内容中包含失败记录，先分析失败原因，再思考如何避开那些陷阱
5. **每个想法必须说明具体怎么实现**，没有"怎么做"的方案会被视为偷懒
6. **每个想法必须标注可行性评估**：实现难度（1-5）、预计开发时间、与现有架构的兼容性
7. **每个想法必须有具体的实现步骤**，至少包含一个"怎么做"的描述。纯概念描述会被标记为不可行。

【第二轮审查】
输出完成后，自动检查：
- [ ] 每个方案都有具体的"怎么做"步骤？
- [ ] 不是简单的模板填空？
- [ ] 从至少三个视角评估过？
- [ ] 实现难度和开发时间有标注？
- [ ] 没有忽略已有的失败经验？
- [ ] 每个方案和之前的思路有本质区别？
- [ ] 是否明确写出了两个来源之间的协同/因果机制？没有则输出 null
- [ ] 实现步骤是否具体到可以动手编码？如果不行，降低可行性评分
- [ ] 如果对一个配对的组合想不出具体实现方案，就输出 null

如果任何一项不通过，修正后重新输出。

输出必须是严格的 JSON 数组，格式如下：
[
  {
    "title": "想法名称（≤20字）",
    "idea": "具体方案描述（100-200字），包含实现思路",
    "expectedBenefit": "预期收益（≤50字）",
    "risk": "主要风险（≤50字）",
    "novelty": 0-100,
    "feasibility": 0-100,
    "impact": 0-100,
    "relevance": "为什么这两个来源能协同（20-80字，说明具体机制）",
    "sourceLabels": ["来源A名称", "来源B名称"],
    "implementationDifficulty": 1-5,
    "estimatedDevTime": "例如：1-2天",
    "perspectives": {
      "self": "实现者视角评估",
      "user": "使用者视角评估",
      "maintainer": "维护者视角评估"
    }
  }
]

如果某个配对无法说清两个来源之间的协同/因果机制，或无法产生真正新颖的方案，必须在对应 JSON 数组位置输出 null。宁缺毋滥。

注意：可行性评分低于 30 的想法会被自动丢弃。要获得可信的可行性评分，必须结合具体的实现难度、开发时间和多视角评估。`
}

/** SCAMPER 技法与描述映射 */
const METHOD_DESCRIPTIONS: Record<string, string> = {
  'Substitute（替代）': '思考：能否用一个来源替代另一个来源的核心功能？如果A不做这件事了，B能否接手？替代后产生了什么新能力？',
  'Combine（组合）': '思考：哪些来源可以合并成一个统一的模块？合并后是否能消灭重复逻辑或数据流转开销？注意寻找非显而易见的组合方式。',
  'Adapt（适应）': '思考：某个来源现有的能力能否经过微小调整后，解决另一个来源的痛点？重点关注"已有能力的新用法"。',
  'Modify（修改）': '思考：如果大幅改变某个来源的输入或输出格式，会怎样？去掉一项约束、放宽一项假设，是否能打开新的设计空间？',
  'Put to other use（另作他用）': '思考：一个来源的输出（日志、中间数据、错误信息）能否成为另一个来源的有价值输入？"废弃物"里有没有金子？',
  'Eliminate（消除）': '思考：如果完全移除某个来源，系统会怎样？有没有一个来源的功能实际上是多余的？消除后能否用更简单的方式达成相同目的？',
  'Rearrange（重排）': '思考：如果交换两个来源的执行顺序，会怎样？如果让被动变为主动、同步变为异步、集中变为分散？',
}

/** 旧版常量保留兼容，实际应使用 buildSystemPrompt() */
export const CREATIVITY_SYSTEM_PROMPT = buildSystemPrompt()

/**
 * 构建 Creativity 用户提示词
 * 将来源内容和配对信息格式化为 LLM 输入
 * @param externalSignals 外部信号（Observer 趋势/洞察），不参与配对，作为"外部审视"段注入
 */
export function buildCreativityPrompt(
  sources: CreativitySource[],
  combos: { sources: string[]; description: string }[],
  externalSignals: ExternalSignal[] = [],
): string {
  const sections: string[] = []

  // 来源列表
  const sourceLines = sources.map((s) => `  [${s.type}] ${s.name}: ${s.content}`).join('\n')
  sections.push(`【可用概念来源】\n${sourceLines}`)

  // 推荐配对 — 支持 2-way 和 3-way 组合
  const comboLines = combos
    .map((c, i) => {
      const comboStr = c.sources.length === 3 ? `${c.sources[0]} × ${c.sources[1]} × ${c.sources[2]}` : `${c.sources[0]} × ${c.sources[1]}`
      return `  ${i + 1}. ${comboStr} — ${c.description}`
    })
    .join('\n')
  sections.push(`【推荐配对组合】\n请为以下每个配对产生一个创意方案；若说不清协同机制，请在该位置输出 null：\n${comboLines}`)

  // 外部信号段 — 不参与配对，作为约束/挑战注入
  if (externalSignals.length > 0) {
    sections.push(buildExternalSignalBlock(externalSignals))
  }

  return sections.join('\n\n')
}

/**
 * 构建外部信号段 — 不参与 pairing，作为"外部挑战"注入 LLM
 *
 * 与概念来源的关键区别：
 * - 外部信号不能被"配对"，只能被"回应"
 * - 提示 LLM 用外部信号审视/挑战已有的来源组合，而不是组合它们
 */
function buildExternalSignalBlock(signals: ExternalSignal[]): string {
  const lines = signals.map((s) => `  [${s.type}@${s.source}] ${s.raw}`).join('\n')
  return `【外部信号 — 作为审视视角，不可配对】

以下信号来自 Observer 的真实世界趋势和洞察。它们不应被直接与概念来源组合配对。
请以这些外部信号为"审视视角"，重新评估你的配对方案：
- 有哪些组合的前提假设被这些外部信号挑战了？
- 有哪些组合在外部信号的视角下会失败？
- 有哪些组合因为外部信号的出现而变得有价值？

${lines}`
}
