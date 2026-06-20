import { resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { log } from '../logger/Logger'
import type {
  Observation,
  AssociationResult,
  DailyObservations,
  TrendReport,
  TopicSelection,
  ResearchResult,
  BrainOutput,
  InsightOutput,
  WorldModelSnapshot,
  EvolutionParams,
  FeedbackSignal,
  UserFeedback,
  TrendLatencyRecord,
} from './types'

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function loadDaily(observationsDir: string, date: string): DailyObservations {
  const file = resolve(observationsDir, `${date}.json`)
  if (!existsSync(file)) return { date, observations: [] }
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return { date, observations: [] }
  }
}

/**
 * ObserverStore — 观察数据的持久化层
 *
 * 扩展后同时支持：
 * - 原有：observations / associations / essays
 * - 新增：trends / topics / research / brains / insights /
 *          world_model / evolution (params + feedback)
 */
export class ObserverStore {
  readonly baseDir: string
  readonly observationsDir: string
  readonly associationsDir: string
  readonly essaysDir: string

  // 新目录
  readonly trendsDir: string
  readonly topicsDir: string
  readonly researchDir: string
  readonly brainsDir: string
  readonly insightsDir: string
  readonly worldModelDir: string
  readonly evolutionDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? resolve(process.cwd(), '.local', 'observer')
    this.observationsDir = resolve(this.baseDir, 'observations')
    this.associationsDir = resolve(this.baseDir, 'associations')
    this.essaysDir = resolve(this.baseDir, 'essays')
    this.trendsDir = resolve(this.baseDir, 'trends')
    this.topicsDir = resolve(this.baseDir, 'topics')
    this.researchDir = resolve(this.baseDir, 'research')
    this.brainsDir = resolve(this.baseDir, 'brains')
    this.insightsDir = resolve(this.baseDir, 'insights')
    this.worldModelDir = resolve(this.baseDir, 'world_model')
    this.evolutionDir = resolve(this.baseDir, 'evolution')
  }

  // ════════════════════════════════════════════════════════════
  // 原有方法（保持完全兼容）
  // ════════════════════════════════════════════════════════════

  /** 生成去重指纹 */
  private fingerprint(obs: Observation): string {
    return `${obs.source}::${obs.content}`
  }

  store(observations: Observation[]): void {
    if (observations.length === 0) return
    ensureDir(this.observationsDir)

    const date = today()
    const daily = loadDaily(this.observationsDir, date)
    const existingFps = new Set(daily.observations.map((o) => this.fingerprint(o)))
    const newOnes = observations.filter((o) => !existingFps.has(this.fingerprint(o)))
    if (newOnes.length === 0) return

    daily.observations.push(...newOnes)
    writeFileSync(resolve(this.observationsDir, `${date}.json`), JSON.stringify(daily, null, 2), 'utf-8')
  }

  readDaily(date: string): DailyObservations {
    ensureDir(this.observationsDir)
    return loadDaily(this.observationsDir, date)
  }

  readRecent(days: number): Observation[] {
    const all: Observation[] = []
    const d = new Date()
    for (let i = 0; i < days; i++) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      all.push(...loadDaily(this.observationsDir, dateStr).observations)
      d.setDate(d.getDate() - 1)
    }
    return all
  }

  saveAssociation(result: AssociationResult): void {
    ensureDir(this.associationsDir)
    const now = new Date()
    const week = `${now.getFullYear()}-W${String(Math.ceil(now.getDate() / 7)).padStart(2, '0')}`
    const file = resolve(this.associationsDir, `${week}.json`)
    let existing: AssociationResult[] = []
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, 'utf-8'))
      } catch {}
    }
    existing.push(result)
    writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8')
  }

  readRecentAssociations(limit = 5): AssociationResult[] {
    ensureDir(this.associationsDir)
    const files = readdirSync(this.associationsDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
    const all: AssociationResult[] = []
    for (const file of files) {
      try {
        const results: AssociationResult[] = JSON.parse(readFileSync(resolve(this.associationsDir, file), 'utf-8'))
        all.push(...results)
      } catch {}
    }
    return all
  }

  saveEssay(content: string, type: 'draft' | 'published' = 'draft'): string {
    ensureDir(resolve(this.essaysDir, type))
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = resolve(this.essaysDir, type, `essay-${ts}.md`)
    writeFileSync(file, content, 'utf-8')
    return file
  }

  // ════════════════════════════════════════════════════════════
  // 新增：Trend Engine
  // ════════════════════════════════════════════════════════════

  saveTrendReport(report: TrendReport): string {
    ensureDir(this.trendsDir)
    const file = resolve(this.trendsDir, `${today()}.json`)
    writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8')
    return file
  }

  readTrendReport(date?: string): TrendReport | null {
    const file = resolve(this.trendsDir, `${date ?? today()}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  // ════════════════════════════════════════════════════════════
  // 新增：Tension Field Engine
  // ════════════════════════════════════════════════════════════

  saveTopicSelection(selection: TopicSelection): string {
    ensureDir(this.topicsDir)
    const file = resolve(this.topicsDir, `${today()}.json`)
    writeFileSync(file, JSON.stringify(selection, null, 2), 'utf-8')
    return file
  }

  readTopicSelection(date?: string): TopicSelection | null {
    const file = resolve(this.topicsDir, `${date ?? today()}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  /** 获取最近 days 天的选题，用于多样性计算 */
  getRecentTopics(days = 7): TopicSelection[] {
    const all: TopicSelection[] = []
    const d = new Date()
    for (let i = 0; i < days; i++) {
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const t = this.readTopicSelection(ds)
      if (t) all.push(t)
      d.setDate(d.getDate() - 1)
    }
    return all
  }

  // ════════════════════════════════════════════════════════════
  // 新增：Deep Research Engine
  // ════════════════════════════════════════════════════════════

  saveResearchResult(topicId: string, result: ResearchResult): string {
    ensureDir(this.researchDir)
    const file = resolve(this.researchDir, `${topicId}.json`)
    writeFileSync(file, JSON.stringify(result, null, 2), 'utf-8')
    return file
  }

  readResearchResult(topicId: string): ResearchResult | null {
    const file = resolve(this.researchDir, `${topicId}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  // ════════════════════════════════════════════════════════════
  // 新增：Multi-Brain Model
  // ════════════════════════════════════════════════════════════

  saveBrainOutputs(topicId: string, outputs: BrainOutput[]): string {
    ensureDir(this.brainsDir)
    const file = resolve(this.brainsDir, `${topicId}.json`)
    writeFileSync(file, JSON.stringify(outputs, null, 2), 'utf-8')
    return file
  }

  readBrainOutputs(topicId: string): BrainOutput[] | null {
    const file = resolve(this.brainsDir, `${topicId}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  // ════════════════════════════════════════════════════════════
  // 新增：Insight Composer
  // ════════════════════════════════════════════════════════════

  saveInsight(insight: InsightOutput): string {
    ensureDir(this.insightsDir)
    const file = resolve(this.insightsDir, `${insight.id}.json`)
    writeFileSync(file, JSON.stringify(insight, null, 2), 'utf-8')
    return file
  }

  readInsight(id: string): InsightOutput | null {
    const file = resolve(this.insightsDir, `${id}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  // ════════════════════════════════════════════════════════════
  // 新增：World Model
  // ════════════════════════════════════════════════════════════

  saveWorldModel(snapshot: WorldModelSnapshot): void {
    ensureDir(this.worldModelDir)
    writeFileSync(resolve(this.worldModelDir, 'entities.json'), JSON.stringify(snapshot.entities, null, 2), 'utf-8')
    writeFileSync(resolve(this.worldModelDir, 'events.json'), JSON.stringify(snapshot.events, null, 2), 'utf-8')
    writeFileSync(resolve(this.worldModelDir, 'trends.json'), JSON.stringify(snapshot.trends, null, 2), 'utf-8')
    writeFileSync(resolve(this.worldModelDir, 'narratives.json'), JSON.stringify(snapshot.narratives, null, 2), 'utf-8')
  }

  readWorldModel(): WorldModelSnapshot {
    const read = <T>(f: string, fallback: T): T => {
      const p = resolve(this.worldModelDir, f)
      if (!existsSync(p)) return fallback
      try {
        return JSON.parse(readFileSync(p, 'utf-8'))
      } catch {
        return fallback
      }
    }
    return {
      entities: read('entities.json', []),
      events: read('events.json', []),
      trends: read('trends.json', []),
      narratives: read('narratives.json', []),
    }
  }

  // ════════════════════════════════════════════════════════════
  // 新增：Self Evolution
  // ════════════════════════════════════════════════════════════

  saveEvolutionParams(params: EvolutionParams): void {
    ensureDir(this.evolutionDir)
    writeFileSync(resolve(this.evolutionDir, 'params.json'), JSON.stringify(params, null, 2), 'utf-8')
  }

  readEvolutionParams(): EvolutionParams | null {
    const file = resolve(this.evolutionDir, 'params.json')
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  saveFeedback(signal: FeedbackSignal): void {
    ensureDir(resolve(this.evolutionDir, 'feedback'))
    const file = resolve(this.evolutionDir, 'feedback', `${today()}.json`)
    let existing: FeedbackSignal[] = []
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, 'utf-8'))
      } catch {}
    }
    existing.push(signal)
    writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8')
  }

  readFeedback(date?: string): FeedbackSignal[] {
    const file = resolve(this.evolutionDir, 'feedback', `${date ?? today()}.json`)
    if (!existsSync(file)) return []
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return []
    }
  }

  readRecentFeedback(days = 7): FeedbackSignal[] {
    const all: FeedbackSignal[] = []
    const d = new Date()
    for (let i = 0; i < days; i++) {
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      all.push(...this.readFeedback(ds))
      d.setDate(d.getDate() - 1)
    }
    return all
  }

  // ════════════════════════════════════════════════════════════
  // 新增：User Feedback（用户显式反馈）
  // ════════════════════════════════════════════════════════════

  saveUserFeedback(feedback: UserFeedback): void {
    ensureDir(resolve(this.evolutionDir, 'user_feedback'))
    const file = resolve(this.evolutionDir, 'user_feedback', `${feedback.topicId}.json`)
    writeFileSync(file, JSON.stringify(feedback, null, 2), 'utf-8')
  }

  readUserFeedback(topicId: string): UserFeedback | null {
    const file = resolve(this.evolutionDir, 'user_feedback', `${topicId}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  getAllUserFeedback(): UserFeedback[] {
    const dir = resolve(this.evolutionDir, 'user_feedback')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(resolve(dir, f), 'utf-8'))
        } catch {
          return null
        }
      })
      .filter((f): f is UserFeedback => f !== null)
  }

  // ════════════════════════════════════════════════════════════
  // 新增：Trend Latency（趋势命中延迟跟踪）
  // ════════════════════════════════════════════════════════════

  saveTrendLatency(record: TrendLatencyRecord): void {
    ensureDir(resolve(this.evolutionDir, 'latency'))
    const file = resolve(this.evolutionDir, 'latency', `${new Date().toISOString().slice(0, 10)}.json`)
    let existing: TrendLatencyRecord[] = []
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, 'utf-8'))
      } catch {}
    }
    existing.push(record)
    writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8')
  }

  readRecentLatency(days = 7): TrendLatencyRecord[] {
    const all: TrendLatencyRecord[] = []
    const d = new Date()
    for (let i = 0; i < days; i++) {
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const file = resolve(this.evolutionDir, 'latency', `${ds}.json`)
      if (existsSync(file)) {
        try {
          const records: TrendLatencyRecord[] = JSON.parse(readFileSync(file, 'utf-8'))
          all.push(...records)
        } catch {}
      }
      d.setDate(d.getDate() - 1)
    }
    return all
  }
}
