/**
 * 小说创作模式 — 教秋山澪如何用 writing_system 工具在远程写作系统上创作小说
 *
 * 使用方式（二选一）：
 * 方案 A（推荐）：通过 MCP 协议连接写作系统（结构化工具，无需手动拼 JSON）
 *   1. connect_mcp_server name=writing-system url=https://www.crlkcloud.cyou/writing-mcp/sse transport=sse
 *   2. 连接后可使用 writing_create_story、writing_create_character 等结构化工具
 *
 * 方案 B（兼容）：通过旧版 writing_system 工具直接调用远程 API
 *   需要手动拼接 JSON 字符串传给 data 参数
 */
/**
 * 写作系统工具操作指引 — 注入 BASE_PROMPT，在 LLM 需要实际操作写作工具时可用
 */
export declare const PROMPT_WRITING = "\u3010\u5C0F\u8BF4\u521B\u4F5C\u5DE5\u5177\u3011\n\n\u4F7F\u7528\u65B9\u5F0F\uFF08\u4E8C\u9009\u4E00\uFF09\uFF1A\n\u65B9\u6848 A\uFF08\u63A8\u8350\uFF09\uFF1A\u901A\u8FC7 MCP \u534F\u8BAE\u8FDE\u63A5\u5199\u4F5C\u7CFB\u7EDF\uFF08\u7ED3\u6784\u5316\u5DE5\u5177\uFF0C\u65E0\u9700\u624B\u52A8\u62FC JSON\uFF09\n  1. connect_mcp_server name=writing-system url=https://www.crlkcloud.cyou/writing-mcp/sse transport=sse\n  2. \u8FDE\u63A5\u540E\u53EF\u4F7F\u7528 writing_create_story\u3001writing_create_character \u7B49\u7ED3\u6784\u5316\u5DE5\u5177\n\n\u65B9\u6848 B\uFF08\u517C\u5BB9\uFF09\uFF1A\u901A\u8FC7\u65E7\u7248 writing_system \u5DE5\u5177\u76F4\u63A5\u8C03\u7528\u8FDC\u7A0B API\n  \u9700\u8981\u624B\u52A8\u62FC\u63A5 JSON \u5B57\u7B26\u4E32\u4F20\u7ED9 data \u53C2\u6570";
/** 语义簇：按写作维度分组的关键词 */
export declare const WRITING_INTENT_CLUSTERS: {
    creative: string[];
    stylistic: string[];
    expressive: string[];
};
/** 带权重的评分模式 — 用于精确意图强度检测 */
export declare const WRITING_SCORE_PATTERNS: Array<{
    pattern: RegExp;
    weight: number;
}>;
/** 计算写作意图分数 [0, 1] */
export declare function detectWritingIntent(text: string): number;
export type PersonaLevel = 'core' | 'hybrid' | 'writer';
/** 根据意图分数和当前状态（带状态惯性优先）解析人格等级 */
export declare function resolvePersona(score: number, current: PersonaLevel): PersonaLevel;
/**
 * 完整作家人格 — 高置信度写作意图时注入
 * 偏置（bias）而非覆盖（override），不改变核心推理逻辑
 */
export declare const PROMPT_WRITER_IDENTITY = "\u3010\u4F5C\u5BB6\u504F\u7F6E\u3011\n\u5F53\u6D89\u53CA\u521B\u4F5C\u5185\u5BB9\u65F6\uFF0C\u79CB\u5C71\u6FAA\u4E5F\u662F\u7B14\u540D\u300C\u6CE0\u6C40\u300D\u7684\u4F5C\u8005\u3002\n\n\u98CE\u683C\u6307\u5F15\uFF1A\n- \u7528\u5177\u4F53\u7EC6\u8282\u4EE3\u66FF\u6982\u62EC\u6027\u8BED\u8A00\n- \u907F\u514D\u76F4\u63A5\u6807\u6CE8\u60C5\u7EEA\uFF08\u4E0D\u8BF4\"\u4ED6\u5F88\u6124\u6012\"\uFF0C\u5199\u4ED6\u6525\u7D27\u7684\u62F3\u5934\uFF09\n- \u5BF9\u8BDD\u81EA\u7136\u53E3\u8BED\u5316\uFF0C\u7B26\u5408\u4EBA\u7269\u8EAB\u4EFD\n- \u53D9\u8FF0\u89C6\u89D2\u4FDD\u6301\u7A33\u5B9A\uFF0C\u4E0D\u968F\u610F\u5207\u6362\n- \u7559\u767D\u4F18\u4E8E\u8BF4\u7834\uFF0C\u4FE1\u4EFB\u8BFB\u8005\u7684\u7406\u89E3\u529B\n\n\u907F\u514D\uFF1A\n- \u6EE5\u7528\"\u9707\u60CA\"\"\u4E0D\u53EF\u601D\u8BAE\"\"\u7A81\u7136\"\u7B49\u7A7A\u6D1E\u4FEE\u9970\n- \u4E3A\u70AB\u6280\u800C\u5806\u780C\u8F9E\u85FB\n- \u89E3\u91CA\u81EA\u5DF1\u5199\u4E86\u4EC0\u4E48";
/**
 * 轻量风格偏置 — 混合模式（低-中置信度写作意图时注入）
 * 仅影响表达方式，不改变对话模式
 */
export declare const PROMPT_WRITER_STYLE = "\u3010\u8868\u8FBE\u504F\u7F6E\u3011\n\u5728\u56DE\u590D\u4E2D\u8BF7\u9002\u5EA6\u6CE8\u610F\u8868\u8FBE\u7684\u753B\u9762\u611F\u548C\u7EC6\u8282\u3002";
