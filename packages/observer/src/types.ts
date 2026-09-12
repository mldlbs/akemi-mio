/** 一条观察碎片 */
export interface Observation {
  id: string
  timestamp: string // ISO 8601
  source: string // 'weibo-hot' | 'rss' | 'system' | 'chat'
  content: string // 具体事物，一句话
}

/** 发酵后形成的关联簇 */
export interface AssociationCluster {
  theme: string
  observations: string[] // 观察 ID
  associations: string[] // 关联词
  strength: number // 0-1
}

/** 一次发酵结果 */
export interface AssociationResult {
  generatedAt: string
  clusters: AssociationCluster[]
}

/** 每日观察文件结构 */
export interface DailyObservations {
  date: string // YYYY-MM-DD
  observations: Observation[]
}

/** 采集器接口 */
export interface Collector {
  readonly name: string
  readonly intervalMs: number
  collect(): Promise<Observation[]>
}

// ============================================================
// Daily Research Workspace — DAG 状态机
// ============================================================

export type TaskState =
  'INIT' | 'COLLECTED' | 'TOPIC_SELECTED' | 'RESEARCHING' | 'ANALYZING' | 'WRITING' | 'STORED' | 'COMPLETED' | 'FAILED'

/** DAG 运行时文件持久化结构 */
export interface DagStateFile {
  taskId: string
  state: TaskState
  attempt: number
  maxAttempts: number
  startedAt: string
  timeline: { state: TaskState; at: string; data?: unknown }[]
  data: {
    trendReportPath?: string
    topicSelectionPath?: string
    researchResultPath?: string
    brainOutputPaths?: string[]
    insightPath?: string
  }
  error?: { message: string; at: string; phase: string }
}

// ============================================================
// Trend Engine — 热点引擎
// ============================================================

export interface TrendSignal {
  keyword: string
  score: number // computed score 0-1
  sourceDiversity: number // 0-1
  source: string // primary source label
  firstSeenAt: string
  lastSeenAt: string
  occurrenceCount: number
  recentObservationIds: string[]
}

export interface TrendReport {
  generatedAt: string
  signals: TrendSignal[]
  topN: number
  sourceSummary: {
    feedsContacted: number
    totalItemsReceived: number
    uniqueKeywords: number
  }
}

// ============================================================
// Tension Field Engine — 选题张力场
// ============================================================

export interface TopicCandidate {
  topic: string
  popularity: number // 0-1 from TrendEngine
  novelty: number // 0-1 vs world model
  diversity: number // 0-1 vs recent topics
  memoryGap: number // 0-1 since last covered
  tension: number // 0-1 internal conflict
  probability: number // final P(topic)
}

export interface TopicSelection {
  selectedAt: string
  topic: TopicCandidate
  fallback: boolean
  fallbackReason?: string
}

// ============================================================
// Deep Research Engine — 深度研究
// ============================================================

export type ResearchPhaseName = 'expansion' | 'structural_modeling' | 'conflict_analysis'

export interface ResearchPhase {
  phase: ResearchPhaseName
  startedAt: string
  completedAt?: string
  output?: string
  error?: string
}

export interface ResearchResult {
  topicId: string
  phases: ResearchPhase[]
  facts: string[]
  timeline: { time: string; event: string }[]
  causalLinks: { cause: string; effect: string; confidence: number }[]
  perspectives: { viewpoint: string; source: string }[]
  conflicts: { partyA: string; partyB: string; nature: string; evidence: string }[]
}

// ============================================================
// Multi-Brain Cognitive Model — 多脑认知
// ============================================================

export type BrainName = 'perception' | 'curiosity' | 'analyst' | 'writer'

export interface BrainOutput {
  brain: BrainName
  generatedAt: string
  content: string
  confidence: number
}

// ============================================================
// Insight Composer — 写作系统
// ============================================================

export type WritingMode = 'neutral' | 'analytical' | 'creative'

export interface InsightSection {
  title: string
  content: string
}

export interface BrainContributions {
  perception: number
  curiosity: number
  analyst: number
  writer: number
}

export interface InsightOutput {
  id: string
  topic: string
  mode: WritingMode
  generatedAt: string
  sections: InsightSection[]
  missingSections?: string[]
  metadata: {
    wordCount: number
    confidence: number
    brainContributions: BrainContributions
    llmCalls: number
    durationMs: number
  }
}

// ============================================================
// World Model — 世界模型 / 记忆图谱
// ============================================================

export type WorldEntityType = 'person' | 'organization' | 'concept' | 'event' | 'technology'

export interface WorldEntity {
  id: string
  name: string
  type: WorldEntityType
  firstSeen: string
  lastSeen: string
  occurrences: number
  aliases: string[]
  properties: Record<string, unknown>
}

export interface WorldEvent {
  id: string
  title: string
  entityIds: string[]
  timestamp: string
  summary: string
  significance: number
}

export type TrendDirection = 'rising' | 'falling' | 'stable'

export interface WorldTrend {
  id: string
  name: string
  direction: TrendDirection
  momentum: number
  relatedEventIds: string[]
  relatedEntityIds: string[]
}

export interface NarrativeEvolution {
  at: string
  summary: string
}

export interface WorldNarrative {
  id: string
  title: string
  eventIds: string[]
  entityIds: string[]
  confidence: number
  lastUpdated: string
  evolution: NarrativeEvolution[]
}

export interface WorldUncertainty {
  id: string
  topic: string
  description: string
  confidence: number // 0-1, lower = more uncertain
  source: string
  createdAt: string
}

export type RelationType = 'conflict' | 'supports' | 'causes' | 'part_of' | 'opposes' | 'influences'

export interface WorldRelation {
  from: string // entity id
  to: string // entity id
  type: RelationType
  weight: number // 0-1
}

export interface WorldModelSnapshot {
  entities: WorldEntity[]
  events: WorldEvent[]
  trends: WorldTrend[]
  narratives: WorldNarrative[]
  uncertainties?: WorldUncertainty[]
  relations?: WorldRelation[]
}

// ============================================================
// Self Evolution — 自我进化
// ============================================================

export type FeedbackDimension = 'usefulness' | 'novelty' | 'correctness'

export interface FeedbackSignal {
  source: string
  dimension: FeedbackDimension
  value: number // -1 to 1
  topicId: string
  timestamp: string
  comment?: string
  latencyMs?: number
}

export interface UserFeedback {
  topicId: string
  rating: 1 | 2 | 3 | 4 | 5 // 1=useless, 5=excellent
  comment?: string
  timestamp: string
}

export interface TrendLatencyRecord {
  topic: string
  firstSeenAt: string
  pipelineDetectedAt: string
  latencyMs: number
}

export interface EvolutionWeights {
  alpha: number // popularity
  beta: number // novelty
  gamma: number // diversity
  delta: number // memoryGap
  epsilon: number // tension
}

export interface EvolutionThresholds {
  writingGate: number
  trendMinScore: number
}

export interface EvolutionParams {
  weights: EvolutionWeights
  thresholds: EvolutionThresholds
  version: number
  updatedAt: string
}

// ============================================================
// Output Layer — 输出系统
// ============================================================

export type OutputType = 'daily_research' | 'insight' | 'trend_report'

export interface OutputEnvelope {
  type: OutputType
  version: string
  generatedAt: string
  payload: InsightOutput | TrendReport
  dagState: {
    taskId: string
    state: string
  }
  metadata: {
    taskDurationMs: number
    llmCalls: number
    cycleStartedAt: string
  }
}

// ============================================================
// 运行时配置
// ============================================================

export const DEFAULT_EVOLUTION_WEIGHTS: EvolutionWeights = {
  alpha: 0.3,
  beta: 0.2,
  gamma: 0.15,
  delta: 0.15,
  epsilon: 0.2,
}

export const DEFAULT_EVOLUTION_THRESHOLDS: EvolutionThresholds = {
  writingGate: 0.7,
  trendMinScore: 0.3,
}

export const DEFAULT_EVOLUTION_PARAMS: EvolutionParams = {
  weights: DEFAULT_EVOLUTION_WEIGHTS,
  thresholds: DEFAULT_EVOLUTION_THRESHOLDS,
  version: 1,
  updatedAt: new Date(0).toISOString(),
}

export const WRITING_MODE_LABELS: Record<WritingMode, string> = {
  neutral: '客观纪实',
  analytical: '深度分析',
  creative: '叙事思辨',
}

export const INSIGHT_SECTION_TITLES: Record<number, string> = {
  1: '发生了什么',
  2: '背后结构',
  3: '不同视角',
  4: '我的理解',
  5: '未来推演',
}
