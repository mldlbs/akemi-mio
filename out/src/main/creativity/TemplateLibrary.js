import { resolveRandom } from '../utils/random';
const TEMPLATES = [
    // ========== FUSION ==========
    {
        category: 'fusion',
        variant: 'merged',
        titleTemplate: '{a} × {b} 深度融合',
        ideaTemplate: '将「{a}」和「{b}」的核心能力通过统一接口层合并，使两者共享数据和上下文。{b} 的输出作为 {a} 的新输入维度，{a} 的状态变化反向驱动 {b} 的行为调整，形成双向往来的融合架构。',
        benefitTemplate: '消除信息孤岛，产生 1+1>2 的涌现效果',
        riskTemplate: '耦合度过高导致两个模块难以独立演进',
        typeFit: { knowledge_knowledge: 10, insight_insight: 9, behavior_behavior: 7 },
        // 不同知识源走向不同策略：ASR×MCP 适合深度融合，Memory×Agent 也是
        nameFit: { 'ASR|MCP': 8, 'Agent|Memory': 8, 'MCP|Agent': 8 },
        noveltyBonus: 18,
        feasibilityBonus: 5,
        impactBonus: 20,
    },
    {
        category: 'fusion',
        variant: 'hybrid_pipeline',
        titleTemplate: '{a}-{b} 混合流水线',
        ideaTemplate: '将「{a}」的处理流程嵌入到「{b}」的管线中，在关键节点插入 {a} 的判断逻辑。两条路径并行执行并在汇合点进行交叉验证，不一致时触发仲裁机制取最优或加权融合。',
        benefitTemplate: '结合两者优势，降低单一路径的系统性偏差',
        riskTemplate: '双路径并行增加延迟和资源消耗',
        typeFit: { knowledge_knowledge: 8, behavior_knowledge: 7, insight_behavior: 6 },
        noveltyBonus: 14,
        feasibilityBonus: 3,
        impactBonus: 16,
    },
    {
        category: 'fusion',
        variant: 'cross_pollination',
        titleTemplate: '{a} 赋能 {b}',
        ideaTemplate: '把「{a}」领域成熟的数据模型和判断规则改造成「{b}」能理解的输入格式，让 {b} 在不重构自身架构的前提下利用 {a} 的知识积累。通过适配器模式渐进集成，先做 POC 验证再全量上线。',
        benefitTemplate: '复用已有资产，快速获得新能力',
        riskTemplate: '适配层可能成为性能瓶颈',
        typeFit: { knowledge_behavior: 9, knowledge_failure: 8, insight_knowledge: 7 },
        noveltyBonus: 10,
        feasibilityBonus: 8,
        impactBonus: 14,
    },
    // ========== TRANSPLANT ==========
    {
        category: 'transplant',
        variant: 'capability_port',
        titleTemplate: '{a} 能力移植到 {b}',
        ideaTemplate: '识别「{a}」中可独立封装的核心算法或策略，将其抽离为通用模块后注入到「{b}」的执行链路中。移植后 {b} 获得 {a} 的核心能力而不需要继承 {a} 的全部复杂度。',
        benefitTemplate: '关键能力低成本复用',
        riskTemplate: '脱离原始上下文后移植效果打折扣',
        typeFit: { knowledge_behavior: 10, behavior_behavior: 8, knowledge_insight: 7 },
        noveltyBonus: 12,
        feasibilityBonus: 7,
        impactBonus: 13,
    },
    {
        category: 'transplant',
        variant: 'pattern_migration',
        titleTemplate: '{a} 设计模式迁移到 {b}',
        ideaTemplate: '分析「{a}」架构中成功的设计模式（事件驱动、分层、插件化等），识别出该模式在 {a} 中解决的具体问题，然后在「{b}」中寻找相同性质的问题域，用适配的方式重构实现。',
        benefitTemplate: '避免重复造轮子，架构决策经过验证',
        riskTemplate: '模式迁移可能引入 {a} 的隐式约束',
        typeFit: { knowledge_behavior: 8, knowledge_knowledge: 9, insight_behavior: 7 },
        /**
         * pattern_migration 是结构化迁移，只适合工程系统间的配对
         * ASR→MCP、Agent→Evolution 有意义
         * Memory→Agent、TTS→Wallpaper 等则不适用 — 没有 nameFit 加成，
         * 自然落到其他模板
         */
        nameFit: { 'ASR|MCP': 8, 'Agent|Evolution': 8 },
        noveltyBonus: 11,
        feasibilityBonus: 8,
        impactBonus: 12,
    },
    {
        category: 'transplant',
        variant: 'algorithm_transfer',
        titleTemplate: '{a} 算法复用到 {b}',
        ideaTemplate: '提取「{a}」核心算法的输入输出接口，为「{b}」的上下文实现一个兼容适配层。复用不追求 1:1 精确移植，而是保留算法核心逻辑并用 {b} 的数据格式做输入输出转换。',
        benefitTemplate: '成熟算法快速落地新场景',
        riskTemplate: '适配层掩盖了算法对 {b} 数据质量的要求',
        typeFit: { knowledge_behavior: 8, knowledge_insight: 6, insight_behavior: 5 },
        noveltyBonus: 9,
        feasibilityBonus: 9,
        impactBonus: 11,
    },
    // ========== CONTRAST ==========
    {
        category: 'contrast',
        variant: 'complementary_roles',
        titleTemplate: '{a} 补完 {b} 盲区',
        ideaTemplate: '分析「{a}」和「{b}」各自的准确率和失败模式，找出 {a} 擅长但 {b} 薄弱、以及 {b} 擅长但 {a} 薄弱的区域。设计一个路由层根据输入特征自动分派到更合适的模块，覆盖双方的盲区。',
        benefitTemplate: '整体准确率超过任何一个独立模块',
        riskTemplate: '路由判断本身引入新的错误来源',
        typeFit: { knowledge_failure: 10, behavior_failure: 9, insight_failure: 9, failure_failure: 8 },
        noveltyBonus: 16,
        feasibilityBonus: 5,
        impactBonus: 18,
    },
    {
        category: 'contrast',
        variant: 'dual_mode',
        titleTemplate: '{a}/{b} 双模切换',
        ideaTemplate: '定义「{a}」和「{b}」各自的最佳工作条件（输入特征、负载范围、响应时间要求）。设计一个监控 + 切换器：条件满足时用 {a}，条件变化时切换到 {b}，切换时做状态保存和恢复保证无缝过渡。',
        benefitTemplate: '在不同场景下始终使用最优方案',
        riskTemplate: '切换逻辑复杂，切换瞬间可能出现抖动',
        typeFit: { behavior_behavior: 8, knowledge_behavior: 7, insight_behavior: 7 },
        noveltyBonus: 14,
        feasibilityBonus: 4,
        impactBonus: 15,
    },
    {
        category: 'contrast',
        variant: 'strength_weakness_weave',
        titleTemplate: '用 {a} 补 {b} 之短',
        ideaTemplate: '列举「{b}」当前的已知短板或失败案例，逐一检查「{a}」中是否有可弥补的能力。为每个短板设计一条 {a}→{b} 的修复链路，优先级按短板影响面排序，逐步缩小 {b} 的能力缺口。',
        benefitTemplate: '有针对性的补齐短板，资源投入回报率高',
        riskTemplate: '过度依赖 {a} 掩盖了 {b} 自身的提升空间',
        typeFit: { failure_knowledge: 10, failure_behavior: 9, failure_insight: 9, failure_failure: 8 },
        noveltyBonus: 15,
        feasibilityBonus: 6,
        impactBonus: 17,
    },
    // ========== FEEDBACK LOOP ==========
    {
        category: 'feedback',
        variant: 'mutual_reinforcement',
        titleTemplate: '{a} ↔ {b} 强化回路',
        ideaTemplate: '设计一个闭环：{a} 的每次执行输出被「{b}」作为反馈信号消费，{b} 分析结果后调整自身的参数或策略，进而影响下一次 {a} 的执行质量。初始阶段人工监控闭环稳定性，收敛后转为自动运行。',
        benefitTemplate: '系统在运行中持续自我优化',
        riskTemplate: '反馈回路可能振荡发散，需要阻尼机制',
        typeFit: { behavior_insight: 10, knowledge_behavior: 8, insight_insight: 8, behavior_behavior: 7 },
        noveltyBonus: 20,
        feasibilityBonus: 3,
        impactBonus: 20,
    },
    {
        category: 'feedback',
        variant: 'closed_loop_optimization',
        titleTemplate: '{b} 根据 {a} 输出自动调优',
        ideaTemplate: '收集「{a}」的每一次执行结果（成功/失败/耗时/质量分），将聚合指标作为「{b}」的超参数输入。{b} 根据历史趋势自动调整阈值、权重或策略选择，形成一个数据驱动的优化闭环。',
        benefitTemplate: '无需人工干预的系统级自动优化',
        riskTemplate: '历史偏差导致调优方向错误',
        typeFit: { behavior_insight: 9, failure_insight: 8, knowledge_insight: 7 },
        noveltyBonus: 18,
        feasibilityBonus: 4,
        impactBonus: 19,
    },
    {
        category: 'feedback',
        variant: 'learning_from_outcome',
        titleTemplate: '{a} 结果驱动的 {b} 进化',
        ideaTemplate: '将「{a}」的执行结果标注为训练信号，定期用新积累的数据微调或更新「{b}」的策略。建立反馈数据集自动去重和采样的机制，避免数据分布偏移导致 {b} 退化。',
        benefitTemplate: '持续学习让系统越来越聪明',
        riskTemplate: '不良数据的累积可能导致模型漂移',
        typeFit: { behavior_failure: 8, insight_failure: 9, knowledge_failure: 7, failure_failure: 7 },
        noveltyBonus: 17,
        feasibilityBonus: 3,
        impactBonus: 18,
    },
    // ========== ABSTRACT ==========
    {
        category: 'abstract',
        variant: 'shared_interface',
        titleTemplate: '{a}/{b} 统一抽象层',
        ideaTemplate: '分析「{a}」和「{b}」的对外接口，找出语义相似的操作抽象为共用接口。先提取只读接口（查询类），再扩展到写接口。两套实现共存于统一接口之后，可以用策略模式在运行时选择具体实现。',
        benefitTemplate: '降低系统整体复杂度，调用方无需感知具体实现',
        riskTemplate: '过度抽象可能丢失各模块的特性能力',
        typeFit: { knowledge_knowledge: 9, behavior_behavior: 7, insight_insight: 6 },
        noveltyBonus: 10,
        feasibilityBonus: 9,
        impactBonus: 12,
    },
    {
        category: 'abstract',
        variant: 'common_core',
        titleTemplate: '抽取 {a} 与 {b} 的共同核心',
        ideaTemplate: '找出「{a}」和「{b}」在数据处理流程、状态管理、错误处理等方面的共性逻辑，将其提取为核心库。核心库只包含无偏见的通用逻辑，具体的领域差异通过插件或策略注入。',
        benefitTemplate: '去重后维护成本减半，修复一处两边受益',
        riskTemplate: '核心库变更的波及面扩大',
        typeFit: { knowledge_knowledge: 8, knowledge_behavior: 6, behavior_behavior: 7 },
        noveltyBonus: 8,
        feasibilityBonus: 10,
        impactBonus: 11,
    },
    {
        category: 'abstract',
        variant: 'generalized_pattern',
        titleTemplate: '从 {a} 和 {b} 中归纳通用模式',
        ideaTemplate: '对比「{a}」的实现路径和「{b}」的实现路径，提取出它们共享的解决模式（如：先过滤再聚合、分级缓存、渐进式加载）。将该模式文档化为设计模板，应用到其他模块的改造中。',
        benefitTemplate: '沉淀架构知识，提升全系统设计一致性',
        riskTemplate: '模式推广可能遭遇各模块的特殊情况',
        typeFit: { insight_knowledge: 8, insight_behavior: 7, insight_insight: 9 },
        noveltyBonus: 12,
        feasibilityBonus: 7,
        impactBonus: 10,
    },
    // ========== METAPHOR ==========
    {
        category: 'metaphor',
        variant: 'domain_mapping',
        titleTemplate: '{a} 式 {b}',
        ideaTemplate: '借用「{a}」领域的概念模型（如：免疫系统、城市规划、进化论）重新思考「{b}」的设计。将 {a} 中的实体和关系一一映射到 {b} 的领域：哪些是细胞/哪些是信号/哪些是防御机制。',
        benefitTemplate: '跳出原有思维框架，发现全新设计可能',
        riskTemplate: '隐喻映射可能强行套用不适配的关系',
        typeFit: { insight_knowledge: 10, insight_behavior: 9, insight_failure: 8, insight_insight: 8 },
        noveltyBonus: 22,
        feasibilityBonus: 2,
        impactBonus: 18,
    },
    {
        category: 'metaphor',
        variant: 'borrowed_heuristic',
        titleTemplate: '{a} 启发下的 {b} 改进',
        ideaTemplate: '从「{a}」的运行原理中提取一条核心启发式规则（如：最少惊讶原则、帕累托改进、最速下降），然后检视「{b}」的当前行为是否违背了该规则，针对违背点设计改进方案。',
        benefitTemplate: '源自成熟领域的第一性原理，适用性广泛',
        riskTemplate: '启发式规则在新领域可能不成立',
        typeFit: { knowledge_insight: 9, knowledge_random: 7, insight_random: 8, behavior_insight: 7 },
        noveltyBonus: 17,
        feasibilityBonus: 5,
        impactBonus: 15,
    },
    {
        category: 'metaphor',
        variant: 'analogical_reasoning',
        titleTemplate: '像 {a} 一样思考 {b}',
        ideaTemplate: '想象如果「{a}」是一个决策主体，它会如何设计「{b}」？分析 {a} 的核心原则（容错优先？效率优先？可解释优先？），将这些原则翻译为 {b} 的功能需求和非功能需求，设计符合 {a} 风格的新方案。',
        benefitTemplate: '跨领域思维碰撞产生意想不到的优雅方案',
        riskTemplate: '风格化设计可能牺牲 {b} 领域的本地优化',
        typeFit: { insight_behavior: 8, insight_knowledge: 7, knowledge_random: 8 },
        noveltyBonus: 20,
        feasibilityBonus: 3,
        impactBonus: 16,
    },
    // ========== INVERSION ==========
    {
        category: 'inversion',
        variant: 'reverse_assumption',
        titleTemplate: '反 {a}：如果 {b} 主导会怎样',
        ideaTemplate: '列举「{a}」和「{b}」当前关系的假设前提（a是主、b是从；a先执行、b后执行；a决策、b执行），逐个反转这些前提。针对每个反转版本评估可行性，挑出有意义的反转方向做原型验证。',
        benefitTemplate: '打破思维定势，发现被忽视的架构可能',
        riskTemplate: '反转方案可能违反领域直觉导致维护困难',
        typeFit: { knowledge_behavior: 8, behavior_behavior: 7, insight_behavior: 9, failure_behavior: 8 },
        noveltyBonus: 22,
        feasibilityBonus: 3,
        impactBonus: 17,
    },
    {
        category: 'inversion',
        variant: 'flip_priority',
        titleTemplate: '从 {b} 出发重新定义 {a}',
        ideaTemplate: '不再问「{a} 如何改进 {b}」，而是问「{b} 需要 {a} 以什么形态存在」。站在 {b} 的消费者视角定义 {a} 的输出格式、响应速度和容错要求，反向重构 {a} 的需求规格。',
        benefitTemplate: '确保 {a} 的输出真正被 {b} 消费，减少浪费',
        riskTemplate: '消费者视角可能忽视 {a} 的内部约束',
        typeFit: { behavior_knowledge: 8, failure_knowledge: 8, insight_knowledge: 7 },
        noveltyBonus: 16,
        feasibilityBonus: 5,
        impactBonus: 14,
    },
    {
        category: 'inversion',
        variant: 'antifragile_design',
        titleTemplate: '让 {b} 从 {a} 的失败中受益',
        ideaTemplate: '不再试图避免「{a}」的失败，而是设计「{b}」使其在 {a} 失败时反而能获得有用信息。例如：{a} 的报错模式 → {b} 建立错误模式库并自动调整阈值；{a} 超时 → {b} 启动降级路径并记录边界值。',
        benefitTemplate: '将系统的弱点转化为信息优势',
        riskTemplate: '需要仔细设计边界条件，失败类型不可穷尽',
        typeFit: { failure_behavior: 10, failure_knowledge: 8, failure_insight: 9, failure_failure: 7 },
        noveltyBonus: 24,
        feasibilityBonus: 3,
        impactBonus: 20,
    },
    // ========== EVOLUTION ==========
    {
        category: 'evolution',
        variant: 'progressive_enhancement',
        titleTemplate: '在 {a} 上渐进引入 {b}',
        ideaTemplate: '不一次性改造 {a}，而是在 {a} 的现有架构上以插件形式注入 {b} 的能力。第一阶段：旁路输出不做决策；第二阶段：作为建议源影响部分决策；第三阶段：在验证可靠后替换 {a} 的核心模块。',
        benefitTemplate: '渐进式升级风险可控，随时可回滚',
        riskTemplate: '过渡期维护两套系统的成本高',
        typeFit: { knowledge_behavior: 8, behavior_behavior: 7, knowledge_failure: 9, behavior_failure: 8 },
        noveltyBonus: 10,
        feasibilityBonus: 8,
        impactBonus: 13,
    },
    {
        category: 'evolution',
        variant: 'layered_adoption',
        titleTemplate: '{b} 作为 {a} 的上层增强',
        ideaTemplate: '保持 {a} 不动，在其上新增一层 {b} 的能力层。{b} 层拦截 {a} 的输入输出，进行预处理或后处理增强。上层能力通过 feature flag 控制，逐步开放给不同用户群体验证效果。',
        benefitTemplate: '不侵入核心逻辑的前提下获得新能力',
        riskTemplate: '上层增强层可能成为黑盒，增加调试难度',
        typeFit: { knowledge_behavior: 7, insight_behavior: 8, knowledge_insight: 7 },
        noveltyBonus: 8,
        feasibilityBonus: 9,
        impactBonus: 11,
    },
    {
        category: 'evolution',
        variant: 'incremental_replacement',
        titleTemplate: '{a} 模块的 {b} 化改造',
        ideaTemplate: '将 {a} 的功能按独立程度拆分为子模块，标记每个子模块是否适合被 {b} 的能力替代。优先替换边界清晰、影响面小的子模块，每替换一个就运行一个月观察稳定性，再决定下一步。',
        benefitTemplate: '大规模改造变成小步快跑的系列任务',
        riskTemplate: '新旧混合期接口兼容性需要持续维护',
        typeFit: { knowledge_knowledge: 7, behavior_behavior: 6, failure_failure: 8 },
        noveltyBonus: 9,
        feasibilityBonus: 9,
        impactBonus: 10,
    },
    // ========== SYMBIOSIS ==========
    {
        category: 'symbiosis',
        variant: 'event_coupling',
        titleTemplate: '{a} 和 {b} 的事件总线',
        ideaTemplate: '通过事件总线连接 {a} 和 {b}：{a} 产生的事件经总线广播，{b} 选择性订阅感兴趣的事件来触发自身行为。总线定义标准化的事件 Schema，{a} 和 {b} 通过 Schema 演进保持兼容。',
        benefitTemplate: '松耦合，各自独立演进不影响对方',
        riskTemplate: '事件 Schema 演进困难，新字段需要消费者配合',
        typeFit: { behavior_behavior: 9, knowledge_behavior: 7, insight_behavior: 7, behavior_failure: 8 },
        noveltyBonus: 14,
        feasibilityBonus: 7,
        impactBonus: 15,
    },
    {
        category: 'symbiosis',
        variant: 'plugin_architecture',
        titleTemplate: '{b} 插件化 {a}',
        ideaTemplate: '将 {a} 的能力接口定义为一组插件契约，{b} 作为插件实现接入。{a} 在运行时通过 ServiceLoader 发现并加载 {b} 的插件，{b} 专注于实现契约而不需关心 {a} 的内部调度。',
        benefitTemplate: '职责边界清晰，{b} 可替换可测试',
        riskTemplate: '插件 API 的稳定性直接影响生态建设',
        typeFit: { knowledge_behavior: 8, behavior_behavior: 8, knowledge_knowledge: 6 },
        noveltyBonus: 11,
        feasibilityBonus: 8,
        impactBonus: 13,
    },
    {
        category: 'symbiosis',
        variant: 'sidecar_pattern',
        titleTemplate: '{a} 附属的 {b} 边车',
        ideaTemplate: '为 {a} 附加一个 {b} 边车进程，{a} 的每次请求先经过边车处理（监控、缓存、过滤、转换）后再到达主逻辑。边车无状态可独立扩缩容，{a} 不需要引入 {b} 的依赖库。',
        benefitTemplate: '横切关注点与主逻辑分离，运维灵活',
        riskTemplate: '边车增加请求链路中的网络跳转',
        typeFit: { behavior_behavior: 7, knowledge_behavior: 7, insight_behavior: 7, failure_behavior: 7 },
        noveltyBonus: 12,
        feasibilityBonus: 7,
        impactBonus: 12,
    },
    // ========== ORCHESTRATE ==========
    {
        category: 'orchestrate',
        variant: 'coordinator',
        titleTemplate: '{a} 编排 {b} 工作流',
        ideaTemplate: '将 {b} 的现有能力封装为标准步骤（step），{a} 作为编配器定义这些步骤的执行顺序、条件分支和异常处理。{a} 维护一个 DAG 定义工作流拓扑，{b} 只关心单个步骤的实现。',
        benefitTemplate: '组合复杂度从单体代码转移到可配置的编配层',
        riskTemplate: '编配器成为单点故障',
        typeFit: { behavior_insight: 8, knowledge_insight: 7, insight_insight: 7 },
        noveltyBonus: 16,
        feasibilityBonus: 6,
        impactBonus: 17,
    },
    {
        category: 'orchestrate',
        variant: 'pipeline_composition',
        titleTemplate: '{a} × {b} 处理流水线',
        ideaTemplate: '将 {a} 和 {b} 组合为一条数据处理流水线：{a} 的输出是 {b} 的输入。每个环节定义明确的输入/输出 Schema，中间结果可缓存可重放。流水线用 JSON 定义，运行时动态加载。',
        benefitTemplate: '处理链路可视化，每个环节可单独调优',
        riskTemplate: '流水线中单环节延迟拖累整体吞吐',
        typeFit: { knowledge_behavior: 8, behavior_behavior: 7, knowledge_knowledge: 7, insight_behavior: 6 },
        noveltyBonus: 11,
        feasibilityBonus: 8,
        impactBonus: 13,
    },
    {
        category: 'orchestrate',
        variant: 'chain_of_thought_flow',
        titleTemplate: '{a} 引导 {b} 的推理链',
        ideaTemplate: '{a} 不直接输出结果，而是生成一条推理路径（中间步骤链），{b} 沿着这条路径逐步验证和执行。{a} 负责任务分解和优先级排序，{b} 负责每一步的细节执行，最终结果由 {b} 汇总返回。',
        benefitTemplate: '复杂任务被拆解为可追溯、可干预的小步骤',
        riskTemplate: '推理链过长时中间步骤的累积误差',
        typeFit: { insight_behavior: 9, insight_knowledge: 8, knowledge_behavior: 7, insight_insight: 7 },
        noveltyBonus: 19,
        feasibilityBonus: 4,
        impactBonus: 18,
    },
];
/**
 * TemplateLibrary — 本地假设生成引擎
 *
 * 使用方式：
 *   1. selectBest(combo, sources) 根据来源类型选择 2-3 个最佳模板
 *   2. fill(template, sourceA, sourceB) 填充模板内容
 *   3. 直接 generate(combo, sources) 一站式生成 Hypothesis
 */
export class TemplateLibrary {
    constructor(seed) {
        this.rng = resolveRandom(seed);
    }
    /**
     * 为一个 ConceptCombo 生成一条假设
     * @returns 生成的 Hypothesis，如果无适用模板则返回 null
     */
    generate(combo, sources) {
        const sourceA = sources.find((s) => s.name === combo.sources[0]);
        const sourceB = sources.find((s) => s.name === combo.sources[1]);
        if (!sourceA || !sourceB)
            return null;
        const typeKey = this.typeKey(sourceA.type, sourceB.type);
        const nameKey = this.nameKey(sourceA.name, sourceB.name);
        const candidates = this.selectForType(typeKey, nameKey);
        if (candidates.length === 0)
            return null;
        // 用来源名称做 hash，保证同源同模板（确定性）
        const idx = this.stableHash(combo.sources[0], combo.sources[1]) % candidates.length;
        const tpl = candidates[idx];
        const id = `hyp_tpl_${Date.now()}_${this.rng().toString(36).slice(2, 6)}`;
        return {
            id,
            title: fill(tpl.titleTemplate, sourceA, sourceB),
            idea: fill(tpl.ideaTemplate, sourceA, sourceB),
            expectedBenefit: fill(tpl.benefitTemplate, sourceA, sourceB),
            risk: fill(tpl.riskTemplate, sourceA, sourceB),
            sourceLabels: [sourceA.name, sourceB.name],
            novelty: clamp50(tpl.noveltyBonus + this.scoreNoise()),
            feasibility: clamp50(tpl.feasibilityBonus + this.scoreNoise()),
            impact: clamp50(tpl.impactBonus + this.scoreNoise()),
            status: 'draft',
            createdAt: Date.now(),
        };
    }
    /**
     * 返回适用于某个类型组合的所有模板列表
     * @param nameKey 对 source name 排序后的组合键，用于 nameFit 二次路由
     */
    selectForType(typeKey, nameKey = '') {
        const [a, b] = typeKey.split('_');
        const reverseKey = `${b}_${a}`;
        const scored = TEMPLATES.map((tpl) => {
            let score = tpl.typeFit[typeKey] ?? tpl.typeFit[reverseKey] ?? 0;
            // nameFit 加成：使模板在不同 name 组合间产生差异
            if (tpl.nameFit && nameKey) {
                score += tpl.nameFit[nameKey] ?? 0;
            }
            return { tpl, score };
        });
        return scored
            .filter((s) => s.score >= 5)
            .sort((a, b) => b.score - a.score)
            .map((s) => s.tpl);
    }
    typeKey(a, b) {
        return [a, b].sort().join('_');
    }
    /** 对 source name 排序生成 nameFit 查询键 */
    nameKey(a, b) {
        return [a, b].sort().join('|');
    }
    stableHash(a, b) {
        let h = 0;
        const s = a + '|' + b;
        for (let i = 0; i < s.length; i++) {
            h = (h << 5) - h + s.charCodeAt(i);
            h = h & h;
        }
        return Math.abs(h);
    }
    /** 评分的小幅随机扰动（0-15），保持一定多样性 */
    scoreNoise() {
        return Math.round(this.rng() * 12);
    }
}
/** 填充模板中的 {a} / {b} 占位符 */
function fill(template, a, b) {
    return template
        .replace(/\{a\}/g, a.name)
        .replace(/\{b\}/g, b.name)
        .replace(/\{aType\}/g, a.type)
        .replace(/\{bType\}/g, b.type);
}
/** 确保分数在 60-100 之间 */
function clamp50(v) {
    return Math.max(60, Math.min(100, v));
}
