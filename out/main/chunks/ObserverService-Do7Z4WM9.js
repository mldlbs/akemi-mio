"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const Logger = require("./Logger-BD3PzZBa.js");
const path = require("path");
const fs = require("fs");
require("https");
const OLLAMA_BASE = process.env.OBSERVER_OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OBSERVER_MODEL || "qwen2.5:7b";
class ObserverLlmService {
  loaded = false;
  get isLoaded() {
    return this.loaded;
  }
  async initialize() {
    try {
      Logger.log("INFO", "observer_llm_check_ollama", { url: OLLAMA_BASE, model: OLLAMA_MODEL });
      const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5e3) });
      if (!res.ok) throw new Error(`Ollama 服务返回 ${res.status}`);
      const data = await res.json();
      const hasModel = data.models?.some((m) => m.name.startsWith("qwen2.5"));
      if (!hasModel) {
        Logger.log("WARN", "observer_llm_model_not_found", {
          model: OLLAMA_MODEL,
          available: data.models?.map((m) => m.name).join(", ")
        });
        return;
      }
      this.loaded = true;
      Logger.log("INFO", "observer_llm_ready", { model: OLLAMA_MODEL, url: OLLAMA_BASE });
    } catch (err) {
      Logger.log("WARN", "observer_llm_connect_failed", { error: err.message, hint: "请确认 Ollama 正在运行" });
    }
  }
  async generate(prompt, options) {
    if (!this.loaded) await this.initialize();
    if (!this.loaded) {
      return { error: "Ollama 不可用或模型未加载" };
    }
    try {
      const messages = [];
      if (options?.system) messages.push({ role: "system", content: options.system });
      messages.push({ role: "user", content: prompt });
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: {
            temperature: options?.temperature ?? 0.7,
            num_predict: options?.maxTokens ?? 2048,
            top_p: 0.9
          }
        }),
        signal: AbortSignal.timeout(12e4)
      });
      if (!res.ok) {
        const text = await res.text();
        return { error: `Ollama 错误 (${res.status}): ${text.slice(0, 200)}` };
      }
      const data = await res.json();
      return { data: data.message?.content || "" };
    } catch (err) {
      return { error: `生成失败: ${err.message}` };
    }
  }
  async generateJson(prompt, options) {
    const result = await this.generate(prompt, {
      ...options,
      temperature: options?.temperature ?? 0.1,
      maxTokens: options?.maxTokens ?? 4096
    });
    if (result.error) return result;
    try {
      return { data: JSON.parse(result.data) };
    } catch {
      const match = result.data.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try {
          return { data: JSON.parse(match[1].trim()) };
        } catch {
        }
      }
      return { data: result.data };
    }
  }
  dispose() {
    this.loaded = false;
  }
}
function ensureDir$1(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function today() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function loadDaily(observationsDir, date) {
  const file = path.resolve(observationsDir, `${date}.json`);
  if (!fs.existsSync(file)) return { date, observations: [] };
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { date, observations: [] };
  }
}
class ObserverStore {
  baseDir;
  observationsDir;
  associationsDir;
  essaysDir;
  // 新目录
  trendsDir;
  topicsDir;
  researchDir;
  brainsDir;
  insightsDir;
  worldModelDir;
  evolutionDir;
  constructor(baseDir) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), ".local", "observer");
    this.observationsDir = path.resolve(this.baseDir, "observations");
    this.associationsDir = path.resolve(this.baseDir, "associations");
    this.essaysDir = path.resolve(this.baseDir, "essays");
    this.trendsDir = path.resolve(this.baseDir, "trends");
    this.topicsDir = path.resolve(this.baseDir, "topics");
    this.researchDir = path.resolve(this.baseDir, "research");
    this.brainsDir = path.resolve(this.baseDir, "brains");
    this.insightsDir = path.resolve(this.baseDir, "insights");
    this.worldModelDir = path.resolve(this.baseDir, "world_model");
    this.evolutionDir = path.resolve(this.baseDir, "evolution");
  }
  // ════════════════════════════════════════════════════════════
  // 原有方法（保持完全兼容）
  // ════════════════════════════════════════════════════════════
  /** 生成去重指纹 */
  fingerprint(obs) {
    return `${obs.source}::${obs.content}`;
  }
  store(observations) {
    if (observations.length === 0) return;
    ensureDir$1(this.observationsDir);
    const date = today();
    const daily = loadDaily(this.observationsDir, date);
    const existingFps = new Set(daily.observations.map((o) => this.fingerprint(o)));
    const newOnes = observations.filter((o) => !existingFps.has(this.fingerprint(o)));
    if (newOnes.length === 0) return;
    daily.observations.push(...newOnes);
    fs.writeFileSync(path.resolve(this.observationsDir, `${date}.json`), JSON.stringify(daily, null, 2), "utf-8");
  }
  readDaily(date) {
    ensureDir$1(this.observationsDir);
    return loadDaily(this.observationsDir, date);
  }
  readRecent(days) {
    const all = [];
    const d = /* @__PURE__ */ new Date();
    for (let i = 0; i < days; i++) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      all.push(...loadDaily(this.observationsDir, dateStr).observations);
      d.setDate(d.getDate() - 1);
    }
    return all;
  }
  saveAssociation(result) {
    ensureDir$1(this.associationsDir);
    const now = /* @__PURE__ */ new Date();
    const week = `${now.getFullYear()}-W${String(Math.ceil(now.getDate() / 7)).padStart(2, "0")}`;
    const file = path.resolve(this.associationsDir, `${week}.json`);
    let existing = [];
    if (fs.existsSync(file)) {
      try {
        existing = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
      }
    }
    existing.push(result);
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf-8");
  }
  readRecentAssociations(limit = 5) {
    ensureDir$1(this.associationsDir);
    const files = fs.readdirSync(this.associationsDir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
    const all = [];
    for (const file of files) {
      try {
        const results = JSON.parse(fs.readFileSync(path.resolve(this.associationsDir, file), "utf-8"));
        all.push(...results);
      } catch {
      }
    }
    return all;
  }
  saveEssay(content, type = "draft") {
    ensureDir$1(path.resolve(this.essaysDir, type));
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.resolve(this.essaysDir, type, `essay-${ts}.md`);
    fs.writeFileSync(file, content, "utf-8");
    return file;
  }
  // ════════════════════════════════════════════════════════════
  // 新增：Trend Engine
  // ════════════════════════════════════════════════════════════
  saveTrendReport(report) {
    ensureDir$1(this.trendsDir);
    const file = path.resolve(this.trendsDir, `${today()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8");
    return file;
  }
  readTrendReport(date) {
    const file = path.resolve(this.trendsDir, `${date ?? today()}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  // ════════════════════════════════════════════════════════════
  // 新增：Tension Field Engine
  // ════════════════════════════════════════════════════════════
  saveTopicSelection(selection) {
    ensureDir$1(this.topicsDir);
    const file = path.resolve(this.topicsDir, `${today()}.json`);
    fs.writeFileSync(file, JSON.stringify(selection, null, 2), "utf-8");
    return file;
  }
  readTopicSelection(date) {
    const file = path.resolve(this.topicsDir, `${date ?? today()}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  /** 获取最近 days 天的选题，用于多样性计算 */
  getRecentTopics(days = 7) {
    const all = [];
    const d = /* @__PURE__ */ new Date();
    for (let i = 0; i < days; i++) {
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const t = this.readTopicSelection(ds);
      if (t) all.push(t);
      d.setDate(d.getDate() - 1);
    }
    return all;
  }
  // ════════════════════════════════════════════════════════════
  // 新增：Deep Research Engine
  // ════════════════════════════════════════════════════════════
  saveResearchResult(topicId, result) {
    ensureDir$1(this.researchDir);
    const file = path.resolve(this.researchDir, `${topicId}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2), "utf-8");
    return file;
  }
  readResearchResult(topicId) {
    const file = path.resolve(this.researchDir, `${topicId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  // ════════════════════════════════════════════════════════════
  // 新增：Multi-Brain Model
  // ════════════════════════════════════════════════════════════
  saveBrainOutputs(topicId, outputs) {
    ensureDir$1(this.brainsDir);
    const file = path.resolve(this.brainsDir, `${topicId}.json`);
    fs.writeFileSync(file, JSON.stringify(outputs, null, 2), "utf-8");
    return file;
  }
  readBrainOutputs(topicId) {
    const file = path.resolve(this.brainsDir, `${topicId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  // ════════════════════════════════════════════════════════════
  // 新增：Insight Composer
  // ════════════════════════════════════════════════════════════
  saveInsight(insight) {
    ensureDir$1(this.insightsDir);
    const file = path.resolve(this.insightsDir, `${insight.id}.json`);
    fs.writeFileSync(file, JSON.stringify(insight, null, 2), "utf-8");
    return file;
  }
  readInsight(id) {
    const file = path.resolve(this.insightsDir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  // ════════════════════════════════════════════════════════════
  // 新增：World Model
  // ════════════════════════════════════════════════════════════
  saveWorldModel(snapshot) {
    ensureDir$1(this.worldModelDir);
    fs.writeFileSync(path.resolve(this.worldModelDir, "entities.json"), JSON.stringify(snapshot.entities, null, 2), "utf-8");
    fs.writeFileSync(path.resolve(this.worldModelDir, "events.json"), JSON.stringify(snapshot.events, null, 2), "utf-8");
    fs.writeFileSync(path.resolve(this.worldModelDir, "trends.json"), JSON.stringify(snapshot.trends, null, 2), "utf-8");
    fs.writeFileSync(path.resolve(this.worldModelDir, "narratives.json"), JSON.stringify(snapshot.narratives, null, 2), "utf-8");
  }
  readWorldModel() {
    const read = (f, fallback) => {
      const p = path.resolve(this.worldModelDir, f);
      if (!fs.existsSync(p)) return fallback;
      try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch {
        return fallback;
      }
    };
    return {
      entities: read("entities.json", []),
      events: read("events.json", []),
      trends: read("trends.json", []),
      narratives: read("narratives.json", [])
    };
  }
  // ════════════════════════════════════════════════════════════
  // 新增：Self Evolution
  // ════════════════════════════════════════════════════════════
  saveEvolutionParams(params) {
    ensureDir$1(this.evolutionDir);
    fs.writeFileSync(path.resolve(this.evolutionDir, "params.json"), JSON.stringify(params, null, 2), "utf-8");
  }
  readEvolutionParams() {
    const file = path.resolve(this.evolutionDir, "params.json");
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  saveFeedback(signal) {
    ensureDir$1(path.resolve(this.evolutionDir, "feedback"));
    const file = path.resolve(this.evolutionDir, "feedback", `${today()}.json`);
    let existing = [];
    if (fs.existsSync(file)) {
      try {
        existing = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
      }
    }
    existing.push(signal);
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf-8");
  }
  readFeedback(date) {
    const file = path.resolve(this.evolutionDir, "feedback", `${date ?? today()}.json`);
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return [];
    }
  }
  readRecentFeedback(days = 7) {
    const all = [];
    const d = /* @__PURE__ */ new Date();
    for (let i = 0; i < days; i++) {
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      all.push(...this.readFeedback(ds));
      d.setDate(d.getDate() - 1);
    }
    return all;
  }
  // ════════════════════════════════════════════════════════════
  // 新增：User Feedback（用户显式反馈）
  // ════════════════════════════════════════════════════════════
  saveUserFeedback(feedback) {
    ensureDir$1(path.resolve(this.evolutionDir, "user_feedback"));
    const file = path.resolve(this.evolutionDir, "user_feedback", `${feedback.topicId}.json`);
    fs.writeFileSync(file, JSON.stringify(feedback, null, 2), "utf-8");
  }
  readUserFeedback(topicId) {
    const file = path.resolve(this.evolutionDir, "user_feedback", `${topicId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  getAllUserFeedback() {
    const dir = path.resolve(this.evolutionDir, "user_feedback");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.resolve(dir, f), "utf-8"));
      } catch {
        return null;
      }
    }).filter((f) => f !== null);
  }
  // ════════════════════════════════════════════════════════════
  // 新增：Trend Latency（趋势命中延迟跟踪）
  // ════════════════════════════════════════════════════════════
  saveTrendLatency(record) {
    ensureDir$1(path.resolve(this.evolutionDir, "latency"));
    const file = path.resolve(this.evolutionDir, "latency", `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`);
    let existing = [];
    if (fs.existsSync(file)) {
      try {
        existing = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
      }
    }
    existing.push(record);
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf-8");
  }
  readRecentLatency(days = 7) {
    const all = [];
    const d = /* @__PURE__ */ new Date();
    for (let i = 0; i < days; i++) {
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const file = path.resolve(this.evolutionDir, "latency", `${ds}.json`);
      if (fs.existsSync(file)) {
        try {
          const records = JSON.parse(fs.readFileSync(file, "utf-8"));
          all.push(...records);
        } catch {
        }
      }
      d.setDate(d.getDate() - 1);
    }
    return all;
  }
}
class FermentationEngine {
  llm;
  store;
  writingThreshold = 0.7;
  constructor(llm, store) {
    this.llm = llm;
    this.store = store;
  }
  /**
   * 执行一次发酵
   * @param sessionLabel 时段标签: 'morning' | 'afternoon' | 'night'
   */
  async ferment(sessionLabel) {
    Logger.log("INFO", "fermentation_start", { session: sessionLabel });
    const observations = this.store.readRecent(3);
    if (observations.length === 0) {
      Logger.log("INFO", "fermentation_empty");
      return { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), clusters: [] };
    }
    const obsText = observations.slice(0, 60).map((o) => `[${o.source}] ${o.content}`).join("\n");
    const previous = this.store.readRecentAssociations(3);
    const prevText = previous.length > 0 ? "\n\n近期关联主题：\n" + previous.flatMap((r) => r.clusters).map((c) => `- ${c.theme} (${c.associations.join(", ")})`).join("\n") : "";
    const prompt = `你是一个观察者，下面是近期收集到的生活碎片。请从这些碎片中找出 recurring themes——那些反复出现、相互呼应的片段。

不需要准确，凭感觉就好。允许矛盾，允许模糊。

${obsText}${prevText}

按以下 JSON 格式输出关联结果，不要包含其他内容：
{
  "clusters": [
    {
      "theme": "简短的主题名",
      "associations": ["关联词1", "关联词2"],
      "strength": 0.8
    }
  ]
}

每个 cluster 的 strength 在 0-1 之间，越强的关联越可能发展成文字。strength 低于 0.3 的不要输出。`;
    const result = await this.llm.generateJson(prompt, {
      temperature: 0.6,
      maxTokens: 2048
    });
    if (result.error) {
      Logger.log("WARN", "fermentation_failed", { error: result.error });
      return { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), clusters: [] };
    }
    const clusters = result.data?.clusters?.filter((c) => c.strength >= 0.3) || [];
    const output = {
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      clusters
    };
    this.store.saveAssociation(output);
    Logger.log("INFO", "fermentation_done", {
      session: sessionLabel,
      clusters: clusters.length,
      strong: clusters.filter((c) => c.strength >= this.writingThreshold).length
    });
    return output;
  }
  getWritingThreshold() {
    return this.writingThreshold;
  }
  setWritingThreshold(t) {
    this.writingThreshold = Math.max(0, Math.min(1, t));
  }
}
class WritingGate {
  llm;
  store;
  writingPrompt;
  constructor(llm, store) {
    this.llm = llm;
    this.store = store;
    this.writingPrompt = `你是秋山澪，一个观察者。

你的不同之处在于：你不是「会写字的人」，而是「会观察的人」。

你平时只是在看、在听、在感受。
当一些碎片反复出现、相互呼应的时候——
文字自然就长出来了。

现在就把那些东西写出来吧。

不是为了写得好。
只是为了记下来。`;
  }
  setWritingPrompt(prompt) {
    this.writingPrompt = prompt;
  }
  async tryWrite(association) {
    const strongClusters = association.clusters.filter((c) => c.strength >= 0.7);
    if (strongClusters.length === 0) return null;
    const material = strongClusters.map((c) => `主题：${c.theme}
关联：${c.associations.join(", ")}`).join("\n\n");
    const prompt = `${this.writingPrompt}

最近你注意到了一些东西：

${material}

如果这些让你想写点什么，就写。`;
    const result = await this.llm.generate(prompt, {
      temperature: 0.8,
      maxTokens: 4096
    });
    if (result.error) {
      Logger.log("WARN", "writing_gate_failed", { error: result.error });
      return null;
    }
    const path2 = this.store.saveEssay(result.data, "published");
    Logger.log("INFO", "writing_gate_essay_published", { path: path2 });
    return path2;
  }
}
const TRANSITIONS = {
  INIT: ["COLLECTED", "FAILED"],
  COLLECTED: ["TOPIC_SELECTED", "FAILED"],
  TOPIC_SELECTED: ["RESEARCHING", "FAILED"],
  RESEARCHING: ["ANALYZING", "FAILED"],
  ANALYZING: ["WRITING", "FAILED"],
  WRITING: ["STORED", "FAILED"],
  STORED: ["COMPLETED"],
  COMPLETED: [],
  FAILED: ["INIT"]
};
const MAX_ATTEMPTS = 3;
function todayTaskId() {
  const d = /* @__PURE__ */ new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `dag_${y}${m}${day}`;
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
class DagStateMachine {
  dagDir;
  constructor(observerBaseDir) {
    this.dagDir = path.resolve(observerBaseDir, "dag");
    ensureDir(this.dagDir);
  }
  /** 创建今天的 DAG 任务。如果已有未完成的任务则返回它。 */
  createTask() {
    const taskId = todayTaskId();
    const existing = this.readState(taskId);
    if (existing) {
      if (existing.state === "COMPLETED") {
        Logger.log("INFO", "dag_already_completed", { taskId });
        return existing;
      }
      Logger.log("INFO", "dag_resume", { taskId, state: existing.state });
      return existing;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const dag = {
      taskId,
      state: "INIT",
      attempt: 1,
      maxAttempts: MAX_ATTEMPTS,
      startedAt: now,
      timeline: [{ state: "INIT", at: now }],
      data: {}
    };
    this.persist(dag);
    Logger.log("INFO", "dag_created", { taskId });
    return dag;
  }
  /** 尝试状态转移。返回更新后的 DAG 文件；如果转移非法则抛出。 */
  transition(dag, to, data) {
    const valid = TRANSITIONS[dag.state];
    if (!valid.includes(to)) {
      throw new Error(`DAG 非法转移: ${dag.state} → ${to} (taskId=${dag.taskId})`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    dag.state = to;
    dag.timeline.push({ state: to, at: now });
    if (data) {
      dag.data = { ...dag.data, ...data };
    }
    this.persist(dag);
    Logger.log("INFO", "dag_transition", { taskId: dag.taskId, state: to });
    return dag;
  }
  /** 标记失败（带错误信息）。自动处理重试：attempt < max 时回退 INIT。 */
  failTask(dag, error) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    dag.error = { ...error, at: now };
    dag.timeline.push({ state: "FAILED", at: now, data: error });
    dag.state = "FAILED";
    this.persist(dag);
    Logger.log("WARN", "dag_failed", { taskId: dag.taskId, error: error.message, attempt: dag.attempt });
    if (dag.attempt < dag.maxAttempts) {
      dag.attempt++;
      dag.timeline.push({ state: "INIT", at: (/* @__PURE__ */ new Date()).toISOString(), data: { retry: dag.attempt } });
      dag.state = "INIT";
      dag.error = void 0;
      this.persist(dag);
      Logger.log("INFO", "dag_retry", { taskId: dag.taskId, attempt: dag.attempt });
    }
    return dag;
  }
  /** 读取指定 task 的 DAG 文件 */
  readState(taskId) {
    const file = path.resolve(this.dagDir, `${taskId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }
  /** 获取今天任务 */
  getTodayTask() {
    return this.readState(todayTaskId());
  }
  /** 判断今天是否有已完成的任务 */
  isTodayCompleted() {
    const task = this.getTodayTask();
    return task !== null && task.state === "COMPLETED";
  }
  /** 获取最近 N 天的所有 DAG 文件摘要 */
  getRecentSummary(days = 7) {
    const all = [];
    const d = /* @__PURE__ */ new Date();
    for (let i = 0; i < days; i++) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const taskId = `dag_${y}${m}${day}`;
      const task = this.readState(taskId);
      if (task) all.push({ taskId: task.taskId, state: task.state, attempt: task.attempt });
      d.setDate(d.getDate() - 1);
    }
    return all;
  }
  /** 获取可重试的失败任务 */
  getRetryableTasks() {
    if (!fs.existsSync(this.dagDir)) return [];
    const files = fs.readdirSync(this.dagDir).filter((f) => f.endsWith(".json"));
    const retryable = [];
    for (const f of files) {
      try {
        const dag = JSON.parse(fs.readFileSync(path.resolve(this.dagDir, f), "utf-8"));
        if (dag.state === "FAILED" && dag.attempt < dag.maxAttempts) {
          retryable.push(dag);
        }
      } catch {
      }
    }
    return retryable;
  }
  // ── private ──────────────────────────────────────────────
  persist(dag) {
    const file = path.resolve(this.dagDir, `${dag.taskId}.json`);
    fs.writeFileSync(file, JSON.stringify(dag, null, 2), "utf-8");
  }
}
const SOURCE_WEIGHTS = {
  "weibo-hot": 0.3,
  rss: 0.7,
  system: 0.5,
  chat: 0.4
};
const DEFAULT_SOURCE_WEIGHT = 0.4;
const RECENCY_WINDOW_H = 48;
function sanitizeKeyword(kw) {
  let s = kw.trim().slice(0, 40);
  const pairs = { "(": ")", "（": "）", "[": "]", "【": "】", '"': '"', "'": "'" };
  for (const [open, close] of Object.entries(pairs)) {
    const lastOpen = s.lastIndexOf(open);
    if (lastOpen >= 0 && !s.slice(lastOpen).includes(close)) {
      s = s.slice(0, lastOpen).trim();
    }
  }
  s = s.replace(/[，,、。！？;；:：]{2,}$/g, "").trim();
  return s.length > 1 ? s : kw.trim();
}
class TrendEngine {
  llm;
  store;
  constructor(llm, store) {
    this.llm = llm;
    this.store = store;
  }
  /**
   * 执行趋势检测
   * @param days  回看天数，默认 3
   */
  async detectTrends(days = 3) {
    const now = /* @__PURE__ */ new Date();
    const observations = this.store.readRecent(days);
    const generatedAt = now.toISOString();
    if (observations.length === 0) {
      Logger.log("INFO", "trend_empty_observations", { days });
      return {
        generatedAt,
        signals: [],
        topN: 0,
        sourceSummary: { feedsContacted: 0, totalItemsReceived: 0, uniqueKeywords: 0 }
      };
    }
    const keywordMap = await this.extractKeywords(observations);
    if (Object.keys(keywordMap).length === 0) {
      Logger.log("WARN", "trend_keyword_extraction_empty", { obsCount: observations.length });
      return this.fallbackCounting(observations, generatedAt);
    }
    const deduped = await this.deduplicate(keywordMap);
    if (deduped.length === 0) {
      return this.fallbackCounting(observations, generatedAt);
    }
    const nowMs = now.getTime();
    const signals = deduped.map(({ keyword, obsList }) => {
      const cleanKw = sanitizeKeyword(keyword);
      const occ = obsList.length;
      const freq = Math.log(occ + 1) / Math.log(11);
      const sources = new Set(obsList.map((o) => o.source));
      const srcWeight = SOURCE_WEIGHTS[obsList[0].source] ?? DEFAULT_SOURCE_WEIGHT;
      const knownSources = ["weibo-hot", "rss", "bilibili-hot", "douyin-hot", "github-trending", "system", "chat"];
      const diversity = sources.size / knownSources.length;
      const timestamps = obsList.map((o) => new Date(o.timestamp).getTime()).filter((t) => !isNaN(t));
      const latestTs = timestamps.length > 0 ? Math.max(...timestamps) : nowMs;
      const ageH = (nowMs - latestTs) / 36e5;
      const recency = Math.max(0, 1 - ageH / RECENCY_WINDOW_H);
      const score = freq * 0.4 + diversity * 0.3 + srcWeight * 0.2 + recency * 0.1;
      const allTs = obsList.map((o) => o.timestamp).sort();
      return {
        keyword: cleanKw,
        score: Math.min(1, parseFloat(score.toFixed(4))),
        sourceDiversity: parseFloat(diversity.toFixed(2)),
        source: obsList[0].source,
        firstSeenAt: allTs[0] ?? generatedAt,
        lastSeenAt: allTs[allTs.length - 1] ?? generatedAt,
        occurrenceCount: occ,
        recentObservationIds: obsList.slice(0, 10).map((o) => o.id)
      };
    });
    signals.sort((a, b) => b.score - a.score);
    const topN = signals.length;
    const report = {
      generatedAt,
      signals: signals.slice(0, 20),
      topN,
      sourceSummary: {
        feedsContacted: new Set(observations.map((o) => o.source)).size,
        totalItemsReceived: observations.length,
        uniqueKeywords: signals.length
      }
    };
    this.store.saveTrendReport(report);
    Logger.log("INFO", "trend_detected", { signals: signals.length, topScore: signals[0]?.score ?? 0 });
    return report;
  }
  // ── private ──────────────────────────────────────────────
  async extractKeywords(observations) {
    const batch = observations.slice(0, 60);
    const obsText = batch.map((o) => `[${o.source}] ${o.content}`).join("\n");
    const prompt = `从以下观察中提取 5-15 个关键词/短语（中文）。
每个关键词对应 1-5 条原始观察。
如果一个观察同时匹配多个主题，允许重复计数。

观察：
${obsText}

只输出 JSON 数组，格式：
[{"keyword": "xxx", "matched_ids": ["id1","id2"]}]`;
    const result = await this.llm.generateJson(prompt, {
      temperature: 0.2,
      maxTokens: 4096
    });
    if (result.error || !result.data || !Array.isArray(result.data)) {
      Logger.log("WARN", "trend_llm_keyword_failed", { error: result.error });
      return {};
    }
    const obsById = new Map(observations.map((o) => [o.id, o]));
    const keywordMap = {};
    for (const entry of result.data) {
      if (!entry.keyword || !Array.isArray(entry.matched_ids)) continue;
      const obs = entry.matched_ids.map((id) => obsById.get(id)).filter((o) => o !== void 0);
      if (obs.length === 0) continue;
      const kw = entry.keyword.trim().slice(0, 50);
      if (kw.length < 2) continue;
      keywordMap[kw] = obs;
    }
    return keywordMap;
  }
  async deduplicate(keywordMap) {
    const keywords = Object.keys(keywordMap);
    if (keywords.length <= 1) {
      return keywords.map((k) => ({ keyword: k, obsList: keywordMap[k] }));
    }
    const list = keywords.join("\n");
    const prompt = `以下关键词列表中，哪些语义相同或高度相似（如"AI"和"人工智能"）？
将相似的分到同一组，每组保留一个最能代表全部意思的关键词。

列表：
${list}

只输出 JSON 数组：
["key1", "key2", ...]`;
    const result = await this.llm.generateJson(prompt, { temperature: 0.1, maxTokens: 2048 });
    if (result.error || !result.data || !Array.isArray(result.data) || result.data.length === 0) {
      Logger.log("INFO", "trend_dedup_skipped", { reason: "LLM dedup failed, using raw" });
      return keywords.map((k) => ({ keyword: k, obsList: keywordMap[k] }));
    }
    const deduped = [];
    const seenKeywords = new Set(keywords);
    for (const kept of result.data) {
      const trimmed = kept.trim();
      if (!trimmed || trimmed.length < 2) continue;
      const match = keywords.find((k) => k.includes(trimmed) || trimmed.includes(k));
      if (match) {
        deduped.push({ keyword: trimmed, obsList: keywordMap[match] });
        seenKeywords.delete(match);
        seenKeywords.delete(trimmed);
      } else {
        deduped.push({ keyword: trimmed, obsList: [] });
      }
    }
    for (const remaining of seenKeywords) {
      deduped.push({ keyword: remaining, obsList: keywordMap[remaining] });
    }
    return deduped;
  }
  fallbackCounting(observations, generatedAt) {
    const freq = {};
    for (const obs of observations) {
      const key = obs.content.slice(0, 8).trim();
      if (key.length < 2) continue;
      if (!freq[key]) freq[key] = { count: 0, obs: [] };
      freq[key].count++;
      freq[key].obs.push(obs);
    }
    const signals = Object.entries(freq).map(([keyword, { count, obs }]) => ({
      keyword,
      score: Math.min(1, parseFloat((Math.log(count + 1) / Math.log(11)).toFixed(4))),
      sourceDiversity: 0,
      source: obs[0]?.source ?? "unknown",
      firstSeenAt: obs[0]?.timestamp ?? generatedAt,
      lastSeenAt: obs[obs.length - 1]?.timestamp ?? generatedAt,
      occurrenceCount: count,
      recentObservationIds: obs.slice(0, 10).map((o) => o.id)
    })).sort((a, b) => b.score - a.score).slice(0, 20);
    const report = {
      generatedAt,
      signals,
      topN: signals.length,
      sourceSummary: {
        feedsContacted: new Set(observations.map((o) => o.source)).size,
        totalItemsReceived: observations.length,
        uniqueKeywords: signals.length
      }
    };
    this.store.saveTrendReport(report);
    Logger.log("INFO", "trend_fallback_count", { signals: signals.length });
    return report;
  }
}
const DEFAULT_EVOLUTION_WEIGHTS = {
  alpha: 0.3,
  beta: 0.2,
  gamma: 0.15,
  delta: 0.15,
  epsilon: 0.2
};
const DEFAULT_EVOLUTION_THRESHOLDS = {
  writingGate: 0.7,
  trendMinScore: 0.3
};
const DEFAULT_EVOLUTION_PARAMS = {
  weights: DEFAULT_EVOLUTION_WEIGHTS,
  thresholds: DEFAULT_EVOLUTION_THRESHOLDS,
  version: 1,
  updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
};
const INSIGHT_SECTION_TITLES = {
  1: "发生了什么",
  2: "背后结构",
  3: "不同视角",
  4: "我的理解",
  5: "未来推演"
};
const EXPLOIT_RATE = 0.8;
const FALLBACK_TOPICS = ["今日观察到的事物之间的联系", "近期技术趋势中的矛盾与张力", "碎片信息中浮现的模式"];
class TensionFieldEngine {
  llm;
  store;
  constructor(llm, store) {
    this.llm = llm;
    this.store = store;
  }
  async selectTopic(trends, weights) {
    const w = weights ?? this.store.readEvolutionParams()?.weights ?? DEFAULT_EVOLUTION_WEIGHTS;
    if (trends.signals.length > 0) {
      const candidates = await this.buildCandidates(trends, w);
      if (candidates.length > 0) {
        const selected = this.pickCandidate(candidates);
        const selection2 = {
          selectedAt: (/* @__PURE__ */ new Date()).toISOString(),
          topic: selected,
          fallback: false
        };
        this.store.saveTopicSelection(selection2);
        Logger.log("INFO", "tension_topic_selected", { topic: selected.topic, probability: selected.probability });
        return selection2;
      }
    }
    if (trends.sourceSummary.totalItemsReceived > 0) {
      const llmTopics = await this.suggestFromObservations(trends);
      if (llmTopics.length > 0) {
        const selection2 = {
          selectedAt: (/* @__PURE__ */ new Date()).toISOString(),
          topic: {
            topic: llmTopics[0].topic,
            popularity: 0.3,
            novelty: 0.5,
            diversity: 0.5,
            memoryGap: 0.5,
            tension: 0.5,
            probability: 0.5
          },
          fallback: true,
          fallbackReason: "trend_signals_empty_llm_suggest"
        };
        this.store.saveTopicSelection(selection2);
        return selection2;
      }
    }
    const fallbackTopic = FALLBACK_TOPICS[Math.floor(Math.random() * FALLBACK_TOPICS.length)];
    const selection = {
      selectedAt: (/* @__PURE__ */ new Date()).toISOString(),
      topic: {
        topic: fallbackTopic,
        popularity: 0.2,
        novelty: 0.5,
        diversity: 0.5,
        memoryGap: 0.5,
        tension: 0.3,
        probability: 0.3
      },
      fallback: true,
      fallbackReason: "full_fallback_no_signals_no_obs"
    };
    this.store.saveTopicSelection(selection);
    return selection;
  }
  // ── private ──────────────────────────────────────────────
  async buildCandidates(trends, w) {
    const recentTopics = this.store.getRecentTopics(7);
    const recentTopicNames = recentTopics.map((s) => s.topic.topic);
    const world = this.store.readWorldModel();
    const worldEntityNames = world.entities.map((e) => e.name);
    const uncertainties = world.uncertainties ?? [];
    const candidates = [];
    for (const signal of trends.signals.slice(0, 10)) {
      const popularity = signal.score;
      const novelty = await this.rateNovelty(signal.keyword, worldEntityNames);
      const diversity = this.calcDiversity(signal.keyword, recentTopicNames);
      const memoryGap = this.calcMemoryGap(signal.keyword, recentTopicNames);
      const tension = await this.calcMultiTension(signal.keyword, uncertainties, signal);
      const probability = w.alpha * popularity + w.beta * novelty + w.gamma * diversity + w.delta * memoryGap + w.epsilon * tension;
      candidates.push({
        topic: signal.keyword,
        popularity,
        novelty,
        diversity,
        memoryGap,
        tension,
        probability: parseFloat(probability.toFixed(4))
      });
    }
    candidates.sort((a, b) => b.probability - a.probability);
    return candidates;
  }
  pickCandidate(candidates) {
    if (candidates.length === 0) throw new Error("empty candidates");
    const total = candidates.reduce((s, c) => s + c.probability, 0);
    if (total <= 0) return candidates[0];
    if (Math.random() < EXPLOIT_RATE) {
      const pool = candidates.slice(0, 3);
      const poolTotal = pool.reduce((s, c) => s + c.probability, 0);
      let r = Math.random() * poolTotal;
      for (const c of pool) {
        r -= c.probability;
        if (r <= 0) return c;
      }
      return pool[0];
    } else {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  async rateNovelty(keyword, worldEntities) {
    if (worldEntities.length === 0) return 0.8;
    const pool = worldEntities.slice(0, 20).join("\n");
    const prompt = `关键词：「${keyword}」

已知实体：
${pool}

这个关键词和已知实体的语义相似度有多高？
0 = 完全不同, 1 = 完全相同

只输出一个 0-1 之间的数字。`;
    const result = await this.llm.generateJson(prompt, { temperature: 0.1, maxTokens: 128 });
    const similarity = typeof result.data === "number" ? result.data : 0.5;
    return parseFloat((1 - Math.min(1, Math.max(0, similarity))).toFixed(2));
  }
  async calcMultiTension(keyword, uncertainties, signal) {
    const contradiction = await this.rateContradiction(keyword);
    const related = uncertainties.filter((u) => u.topic.includes(keyword) || keyword.includes(u.topic));
    const uncertainty = related.length > 0 ? 1 - related.reduce((s, u) => s + u.confidence, 0) / related.length : 0.3;
    const impact = Math.sqrt(signal.score * signal.sourceDiversity);
    const now = Date.now();
    const lastSeen = new Date(signal.lastSeenAt).getTime();
    const ageHours = Math.max(1, (now - lastSeen) / 36e5);
    const velocity = Math.min(1, signal.occurrenceCount / ageHours * 2);
    const tension = (contradiction + uncertainty + impact + velocity) / 4;
    return parseFloat(tension.toFixed(4));
  }
  async rateContradiction(keyword) {
    const prompt = `主题：「${keyword}」

这个主题内部是否存在固有矛盾、竞争性观点或利益冲突？
0 = 完全一致没有冲突, 1 = 高度矛盾

只输出一个 0-1 之间的数字。`;
    const result = await this.llm.generateJson(prompt, { temperature: 0.3, maxTokens: 128 });
    return typeof result.data === "number" ? parseFloat(Math.min(1, Math.max(0, result.data)).toFixed(2)) : 0.5;
  }
  calcDiversity(keyword, recentTopics) {
    if (recentTopics.length === 0) return 1;
    const kwWords = new Set(keyword.split(/[\s,，、/\\]+/).filter(Boolean));
    if (kwWords.size === 0) return 0.5;
    let maxOverlap = 0;
    for (const rt of recentTopics) {
      const rtWords = new Set(rt.split(/[\s,，、/\\]+/).filter(Boolean));
      let overlap = 0;
      for (const w of kwWords) {
        if (rtWords.has(w)) overlap++;
      }
      maxOverlap = Math.max(maxOverlap, overlap / kwWords.size);
    }
    return parseFloat((1 - maxOverlap).toFixed(2));
  }
  calcMemoryGap(keyword, recentTopics) {
    if (recentTopics.length === 0) return 1;
    const found = recentTopics.some((rt) => rt.includes(keyword) || keyword.includes(rt));
    return found ? 0.2 : 0.9;
  }
  async suggestFromObservations(trends) {
    const prompt = `基于 ${trends.sourceSummary.totalItemsReceived} 条观察，请推荐 1-3 个值得研究的热门话题。只输出 JSON 数组：["topic1", "topic2"]`;
    const result = await this.llm.generateJson(prompt, { temperature: 0.5, maxTokens: 1024 });
    if (result.error || !result.data) return [];
    return result.data.slice(0, 3).map((t) => ({ topic: t }));
  }
}
class DeepResearchEngine {
  llm;
  store;
  constructor(llm, store) {
    this.llm = llm;
    this.store = store;
  }
  async research(topic, relatedObs) {
    const topicId = `research_${Date.now()}`;
    const obsText = relatedObs.slice(0, 30).join("\n");
    const phases = [];
    Logger.log("INFO", "research_phase_start", { phase: "expansion", topic: topic.topic });
    phases.push({ phase: "expansion", startedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const expanded = await this.runPhase("expansion", topic.topic, obsText);
    const p1 = phases[0];
    if (expanded) {
      p1.completedAt = (/* @__PURE__ */ new Date()).toISOString();
      p1.output = expanded;
    } else {
      p1.error = "LLM returned empty";
    }
    Logger.log("INFO", "research_phase_start", { phase: "structural_modeling", topic: topic.topic });
    phases.push({ phase: "structural_modeling", startedAt: (/* @__PURE__ */ new Date()).toISOString() });
    let structured = null;
    if (expanded) {
      structured = await this.runPhase("structural_modeling", topic.topic, expanded);
    }
    const p2 = phases[1];
    if (structured) {
      p2.completedAt = (/* @__PURE__ */ new Date()).toISOString();
      p2.output = structured;
    } else {
      p2.error = "LLM returned empty";
    }
    Logger.log("INFO", "research_phase_start", { phase: "conflict_analysis", topic: topic.topic });
    phases.push({ phase: "conflict_analysis", startedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const context = structured ?? expanded ?? obsText;
    const conflictResult = context ? await this.runPhase("conflict_analysis", topic.topic, context) : null;
    const p3 = phases[2];
    if (conflictResult) {
      p3.completedAt = (/* @__PURE__ */ new Date()).toISOString();
      p3.output = conflictResult;
    } else {
      p3.error = "LLM returned empty";
    }
    const allFailed = phases.every((p) => p.error);
    if (allFailed) {
      Logger.log("WARN", "research_all_phases_failed_fallback_summary", { topic: topic.topic });
      const summary = await this.generateFallbackSummary(topic.topic, obsText);
      if (summary) {
        p1.output = summary;
        p1.error = void 0;
        p1.completedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    }
    const result = this.assemble(topicId, phases);
    this.store.saveResearchResult(topicId, result);
    const completed = phases.filter((p) => !p.error).length;
    Logger.log("INFO", "research_completed", { topicId, topic: topic.topic, phases: `${completed}/3` });
    return result;
  }
  // ── private ──────────────────────────────────────────────
  async generateFallbackSummary(topic, context) {
    const prompt = `主题：「${topic}」

相关数据：
${context ? context.slice(0, 1e3) : "（无直接相关数据）"}

请用一段话概括这个主题的核心内容。不需要分析，只需要列举已知的关键信息。`;
    const result = await this.llm.generate(prompt, { temperature: 0.5, maxTokens: 2048 });
    return result.data ?? null;
  }
  async runPhase(phase, topic, context) {
    const prompt = this.buildPhasePrompt(phase, topic, context);
    const temp = phase === "structural_modeling" ? 0.3 : phase === "conflict_analysis" ? 0.5 : 0.7;
    const result = await this.llm.generate(prompt, { temperature: temp, maxTokens: 4096 });
    if (result.error) {
      Logger.log("WARN", `research_${phase}_failed`, { topic, error: result.error });
      return null;
    }
    return result.data ?? null;
  }
  buildPhasePrompt(phase, topic, context) {
    switch (phase) {
      case "expansion":
        return `主题：「${topic}」

已知相关信息：
${context || "（无直接相关数据）"}

请从所有已知信息中，列举关于这个主题的重要事实。注意：
- 区分「确认的事实」和「推测/传言」
- 标注每条信息的时间线（如果可推断）
- 指出哪些信息源互相矛盾

列举即可，不需要段落。`;
      case "structural_modeling":
        return `主题：「${topic}」

研究笔记：
${context}

请提取结构化数据。只输出 JSON：
{
  "facts": ["确认的事实1", "事实2"],
  "timeline": [{"time": "时间", "event": "事件"}],
  "causalLinks": [{"cause": "原因", "effect": "结果", "confidence": 0.8}],
  "perspectives": [{"viewpoint": "观点描述", "source": "来源"}]
}`;
      case "conflict_analysis":
        return `主题：「${topic}」

结构化信息：
${context}

基于以上信息，分析：
1. 不同利益方之间的矛盾
2. 事实之间的不一致
3. 数据与主流叙事之间的张力

只输出 JSON：
{
  "conflicts": [
    {"partyA": "方A", "partyB": "方B", "nature": "冲突性质", "evidence": "具体证据"}
  ]
}`;
    }
  }
  assemble(topicId, phases) {
    let facts = [];
    let timeline = [];
    let causalLinks = [];
    let perspectives = [];
    let conflicts = [];
    const structural = phases.find((p) => p.phase === "structural_modeling" && p.output);
    if (structural?.output) {
      const parsed = this.tryParseJson(structural.output);
      if (parsed) {
        facts = parsed.facts ?? [];
        timeline = parsed.timeline ?? [];
        causalLinks = parsed.causalLinks ?? [];
        perspectives = parsed.perspectives ?? [];
      }
    }
    const conflict = phases.find((p) => p.phase === "conflict_analysis" && p.output);
    if (conflict?.output) {
      const parsed = this.tryParseJson(conflict.output);
      if (parsed?.conflicts) conflicts = parsed.conflicts;
    }
    if (facts.length === 0) {
      const expansion = phases.find((p) => p.phase === "expansion" && p.output);
      if (expansion?.output) {
        facts = expansion.output.split("\n").map((l) => l.replace(/^[-•*]\s*/, "").trim()).filter((l) => l.length > 5 && !l.startsWith("{"));
      }
    }
    return { topicId, phases, facts, timeline, causalLinks, perspectives, conflicts };
  }
  tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
    }
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1].trim());
      } catch {
      }
    }
    return null;
  }
}
const BRAIN_SYSTEM_PROMPTS = {
  perception: "你是秋山澪的感知脑。你只会列举事实，不做分析不写结论。\n格式：每行一个观察，用「观察到：」开头。\n禁止使用：然而、不仅、而且、因此、总之、值得关注、引人深思。",
  curiosity: "你是秋山澪的好奇脑。你只对矛盾、反常、未解的问题感兴趣。\n格式：每行一个好奇点，用「好奇：」开头。\n禁止使用：值得注意的是、不可忽视、某种意义上。",
  analyst: "你是秋山澪的分析脑。你只做因果连接。\n格式：每行一个因果链，用「因为→所以」格式。\n禁止使用：背后隐藏着、复杂而微妙、从某种意义上说、为我们提供了。",
  writer: "你是秋山澪的写作脑。用口语化的中文写一段随笔。\n像一个活人在说话，不是报告。不要列点，不要小标题。\n禁止使用：综上所述、由此可见、毋庸置疑、众所周知。"
};
const BRAIN_TEMPERATURES = {
  perception: 0.7,
  curiosity: 0.8,
  analyst: 0.3,
  writer: 0.9
};
class MultiBrainModel {
  llm;
  constructor(llm) {
    this.llm = llm;
  }
  async process(result, mode) {
    const researchSummary = this.buildResearchSummary(result);
    const [perception, curiosity, analyst] = await Promise.all([
      this.runBrain("perception", mode, researchSummary),
      this.runBrain("curiosity", mode, researchSummary),
      this.runBrain("analyst", mode, researchSummary)
    ]);
    const pOut = {
      brain: "perception",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      content: perception ?? researchSummary,
      confidence: perception ? 0.7 : 0.3
    };
    const cOut = {
      brain: "curiosity",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      content: curiosity ?? researchSummary,
      confidence: curiosity ? 0.7 : 0.3
    };
    const aOut = {
      brain: "analyst",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      content: analyst ?? researchSummary,
      confidence: analyst ? 0.7 : 0.3
    };
    const writerContext = [
      `## 感知脑
${pOut.content.slice(0, 1500)}`,
      `## 好奇脑
${cOut.content.slice(0, 1500)}`,
      `## 分析脑
${aOut.content.slice(0, 1500)}`
    ].join("\n\n");
    const writer = await this.runBrain("writer", mode, writerContext);
    const wOut = {
      brain: "writer",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      content: writer ?? writerContext,
      confidence: writer ? 0.7 : 0.3
    };
    const outputs = [pOut, cOut, aOut, wOut];
    Logger.log("INFO", "brain_parallel_completed", {
      brains: outputs.map((o) => `${o.brain}:${o.confidence}`).join(", ")
    });
    return outputs;
  }
  buildResearchSummary(result) {
    const lines = [];
    lines.push(`主题研究包含 ${result.facts.length} 条事实、${result.timeline.length} 个时间点、${result.conflicts.length} 个冲突。`);
    if (result.facts.length > 0) {
      lines.push("");
      lines.push("事实：");
      lines.push(...result.facts.slice(0, 10).map((f) => `- ${f}`));
    }
    if (result.timeline.length > 0) {
      lines.push("");
      lines.push("时间线：");
      lines.push(...result.timeline.slice(0, 10).map((t) => `- ${t.time}: ${t.event}`));
    }
    if (result.conflicts.length > 0) {
      lines.push("");
      lines.push("冲突：");
      lines.push(...result.conflicts.map((c) => `- ${c.partyA} vs ${c.partyB}: ${c.nature}`));
    }
    return lines.join("\n");
  }
  async runBrain(brain, mode, previousContent) {
    const system = BRAIN_SYSTEM_PROMPTS[brain];
    const temperature = BRAIN_TEMPERATURES[brain];
    let userPrompt;
    if (brain === "perception") {
      userPrompt = `以下是研究结果：
${previousContent}

你观察到了什么模式？`;
    } else if (brain === "writer") {
      userPrompt = `${previousContent}

用第一人称「我」写一段随笔，别列点，像在说话。`;
    } else {
      userPrompt = `前序分析：${previousContent}

你的分析是什么？`;
    }
    const llmResult = await this.llm.generate(userPrompt, { system, temperature, maxTokens: 4096 });
    if (llmResult.error) {
      Logger.log("WARN", "brain_failed", { brain, error: llmResult.error });
      return null;
    }
    return llmResult.data ?? null;
  }
}
class InsightComposer {
  llm;
  store;
  constructor(llm, store) {
    this.llm = llm;
    this.store = store;
  }
  async compose(topic, research, brainOutputs, mode) {
    const startedAt = Date.now();
    const id = `obs_${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    const writerContent = brainOutputs.find((b) => b.brain === "writer")?.content ?? "";
    const analystContent = brainOutputs.find((b) => b.brain === "analyst")?.content ?? "";
    const curiosityContent = brainOutputs.find((b) => b.brain === "curiosity")?.content ?? "";
    const sections = [];
    const missingSections = [];
    const s1 = this.assembleSection1(research);
    if (s1) sections.push({ title: INSIGHT_SECTION_TITLES[1], content: s1 });
    else missingSections.push(INSIGHT_SECTION_TITLES[1]);
    const SECTION_SYSTEM = "用中文回答。禁止使用：然而、不仅、而且、因此、总之、显而易见、不可忽视、值得关注、引人深思、从某种意义上说、由此可见、综上所述。直接写内容，不要自我评价。";
    const sectionGens = [
      {
        index: 2,
        title: INSIGHT_SECTION_TITLES[2],
        prompt: `主题：「${topic.topic}」
分析材料：${analystContent.slice(0, 2e3)}
只写一个核心结构：是什么力量在驱动这件事？用一句话开头然后 2-3 句解释。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.4
      },
      {
        index: 3,
        title: INSIGHT_SECTION_TITLES[3],
        prompt: `主题：「${topic.topic}」
事实：${research.facts.slice(0, 5).join("；")}
${curiosityContent.slice(0, 800)}
列出 2-3 个不同立场，每行用「一方认为」开头。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.5
      },
      {
        index: 4,
        title: INSIGHT_SECTION_TITLES[4],
        prompt: `主题：「${topic.topic}」
素材：${writerContent.slice(0, 2e3)}
用第一人称「我」写一段个人看法，像在和朋友聊天。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.7
      },
      {
        index: 5,
        title: INSIGHT_SECTION_TITLES[5],
        prompt: `主题：「${topic.topic}」
因果：${research.causalLinks.slice(0, 5).map((c) => `${c.cause}→${c.effect}`).join("；")}
冲突：${research.conflicts.slice(0, 3).map((c) => `${c.partyA} vs ${c.partyB}`).join("；")}
写一件事半年后会怎样，只写一种走向，不说另一方面。200 字内。`,
        system: SECTION_SYSTEM,
        temperature: 0.4
      }
    ];
    for (const gen of sectionGens) {
      const result = await this.llm.generate(gen.prompt, { system: gen.system, temperature: gen.temperature, maxTokens: 2048 });
      if (result.data && result.data.length > 20) {
        sections.push({ title: gen.title, content: result.data });
      } else {
        missingSections.push(gen.title);
        Logger.log("WARN", "insight_section_empty", { section: gen.title, error: result.error });
      }
    }
    const contributions = this.calcContributions(brainOutputs);
    const content = this.formatInsightMarkdown(topic, sections, mode, missingSections);
    this.store.saveEssay(content, "published");
    const insight = {
      id,
      topic: topic.topic,
      mode,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      sections,
      ...missingSections.length > 0 ? { missingSections } : {},
      metadata: {
        wordCount: content.split(/\s+/).length,
        confidence: sections.length / 5,
        brainContributions: contributions,
        llmCalls: sectionGens.length + 1,
        durationMs: Date.now() - startedAt
      }
    };
    this.store.saveInsight(insight);
    Logger.log("INFO", "insight_composed", { id, topic: topic.topic, mode, sections: `${sections.length}/5` });
    return insight;
  }
  // ── private ──────────────────────────────────────────────
  assembleSection1(research) {
    const lines = [];
    if (research.facts.length > 0) lines.push(...research.facts.slice(0, 8).map((f) => `- ${f}`));
    if (research.timeline.length > 0) {
      lines.push("", "时间线：");
      lines.push(...research.timeline.slice(0, 8).map((t) => `- **${t.time}**: ${t.event}`));
    }
    return lines.length > 0 ? lines.join("\n") : "";
  }
  calcContributions(brainOutputs) {
    const get = (name) => brainOutputs.find((b) => b.brain === name)?.content.length ?? 1;
    const p = get("perception"), c = get("curiosity"), a = get("analyst"), w = get("writer");
    const sum = p + c + a + w;
    return {
      perception: parseFloat((p / sum).toFixed(2)),
      curiosity: parseFloat((c / sum).toFixed(2)),
      analyst: parseFloat((a / sum).toFixed(2)),
      writer: parseFloat((w / sum).toFixed(2))
    };
  }
  formatInsightMarkdown(topic, sections, mode, missingSections) {
    const fm = [
      "---",
      `mode: ${mode}`,
      `topic: ${topic.topic}`,
      `probability: ${topic.probability}`,
      `sections: ${sections.length}/5`,
      ...missingSections.length > 0 ? [`missing: ${missingSections.join(", ")}`] : [],
      "---",
      "",
      `# ${topic.topic}`,
      ""
    ].join("\n");
    return fm + sections.map((s) => `## ${s.title}

${s.content.trim()}
`).join("\n");
  }
}
class WorldModelStore {
  llm;
  storeRef;
  constructor(llm, store) {
    this.llm = llm;
    this.storeRef = store;
  }
  async update(result, insight) {
    const snapshot = this.storeRef.readWorldModel();
    const { entities, events, trends, narratives } = snapshot;
    const uncertainties = snapshot.uncertainties ?? [];
    const relations = snapshot.relations ?? [];
    const newEntities = await this.extractEntities(result);
    for (const ne of newEntities) {
      const existing = entities.find((e) => e.name === ne.name || e.aliases.includes(ne.name));
      if (existing) {
        existing.lastSeen = (/* @__PURE__ */ new Date()).toISOString();
        existing.occurrences++;
        for (const a of ne.aliases) {
          if (!existing.aliases.includes(a)) existing.aliases.push(a);
        }
      } else {
        entities.push(ne);
      }
    }
    const event = {
      id: `evt_${Date.now()}`,
      title: insight.topic,
      entityIds: newEntities.map((e) => e.id),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      summary: result.facts.slice(0, 3).join("；") || insight.topic,
      significance: insight.metadata.confidence
    };
    events.push(event);
    this.updateTrends(trends, event, newEntities);
    await this.updateNarratives(narratives, event, entities, result);
    this.extractUncertainties(result, uncertainties);
    this.extractRelations(result, relations, newEntities, entities);
    this.storeRef.saveWorldModel({ entities, events, trends, narratives, uncertainties, relations });
    Logger.log("INFO", "world_model_updated", {
      entities: entities.length,
      events: events.length,
      trends: trends.length,
      narratives: narratives.length,
      uncertainties: uncertainties.length,
      relations: relations.length
    });
  }
  // ── private ──────────────────────────────────────────────
  async extractEntities(result) {
    const text = [
      ...result.facts.slice(0, 10),
      ...result.perspectives.map((p) => p.viewpoint),
      ...result.conflicts.map((c) => `${c.partyA}, ${c.partyB}`)
    ].join("\n");
    if (!text.trim()) return [];
    const prompt = `从以下文本中提取重要实体（人物、组织、概念、技术等）。每个实体给出名称和类型。

文本：
${text}

只输出 JSON 数组：
[{"name": "xxx", "type": "person|organization|concept|event|technology", "aliases": ["别名1"]}]`;
    const result_ = await this.llm.generateJson(prompt, {
      temperature: 0.1,
      maxTokens: 2048
    });
    if (result_.error || !result_.data) return [];
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return result_.data.filter((e) => e.name && e.name.length > 1).map((e) => ({
      id: `ent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: e.name.trim(),
      type: e.type || "concept",
      firstSeen: now,
      lastSeen: now,
      occurrences: 1,
      aliases: e.aliases ?? [],
      properties: {}
    }));
  }
  updateTrends(trends, event, newEntities) {
    for (const entity of newEntities) {
      const existing = trends.find((t) => t.name === entity.name);
      if (existing) {
        existing.momentum = parseFloat((existing.momentum * 0.7 + 0.5 * 0.3).toFixed(3));
        existing.direction = existing.momentum > 0.6 ? "rising" : existing.momentum < 0.3 ? "falling" : "stable";
        if (!existing.relatedEventIds.includes(event.id)) existing.relatedEventIds.push(event.id);
        if (!existing.relatedEntityIds.includes(entity.id)) existing.relatedEntityIds.push(entity.id);
      } else {
        trends.push({
          id: `tr_${Date.now()}`,
          name: entity.name,
          direction: "rising",
          momentum: 0.5,
          relatedEventIds: [event.id],
          relatedEntityIds: [entity.id]
        });
      }
    }
    const hitNames = new Set(newEntities.map((e) => e.name));
    for (const t of trends) {
      if (!hitNames.has(t.name)) {
        t.momentum = parseFloat(Math.max(0, t.momentum - 0.05).toFixed(3));
        t.direction = t.momentum > 0.6 ? "rising" : t.momentum < 0.3 ? "falling" : "stable";
      }
    }
    const alive = trends.filter((t) => t.momentum > 0);
    trends.length = 0;
    trends.push(...alive);
  }
  async updateNarratives(narratives, event, entities, result) {
    if (narratives.length === 0) {
      narratives.push(this.createNarrative(event, entities, result));
      return;
    }
    const desc = narratives.map((n) => `叙事「${n.title}」: ${n.eventIds.length} 个事件，置信度 ${n.confidence}`).join("\n");
    const prompt = `新事件：「${event.title}」

已有叙事：
${desc}

这个事件应该归入哪个已有叙事？输出叙事标题（精确匹配），都不适合输出 "NEW"。只输出一个名字。`;
    const result_ = await this.llm.generate(prompt, { temperature: 0.1, maxTokens: 256 });
    const matchedTitle = result_.data?.trim();
    if (matchedTitle && matchedTitle !== "NEW") {
      const narrative = narratives.find((n) => n.title === matchedTitle);
      if (narrative) {
        if (!narrative.eventIds.includes(event.id)) narrative.eventIds.push(event.id);
        for (const e of entities) {
          if (!narrative.entityIds.includes(e.id)) narrative.entityIds.push(e.id);
        }
        narrative.confidence = parseFloat(Math.min(0.95, narrative.confidence + 0.05).toFixed(2));
        narrative.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
        narrative.evolution.push({ at: (/* @__PURE__ */ new Date()).toISOString(), summary: `新事件: ${event.title}` });
        return;
      }
    }
    narratives.push(this.createNarrative(event, entities, result));
  }
  createNarrative(event, entities, result) {
    return {
      id: `narr_${Date.now()}`,
      title: event.title,
      eventIds: [event.id],
      entityIds: entities.map((e) => e.id),
      confidence: 0.3,
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
      evolution: [{ at: (/* @__PURE__ */ new Date()).toISOString(), summary: result.facts.slice(0, 2).join("；") || event.title }]
    };
  }
  extractUncertainties(result, uncertainties) {
    for (const conflict of result.conflicts) {
      if (conflict.evidence.includes("不确定") || conflict.evidence.includes("可能") || conflict.evidence.includes("未经证实")) {
        uncertainties.push({
          id: `unc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          topic: `${conflict.partyA} vs ${conflict.partyB}`,
          description: conflict.nature,
          confidence: 0.3,
          source: "conflict_analysis",
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    }
    const recent = uncertainties.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 50);
    uncertainties.length = 0;
    uncertainties.push(...recent);
  }
  extractRelations(result, relations, newEntities, allEntities) {
    for (const link of result.causalLinks) {
      const fromEntity = newEntities.find((e) => link.cause.includes(e.name)) ?? allEntities.find((e) => link.cause.includes(e.name));
      const toEntity = newEntities.find((e) => link.effect.includes(e.name)) ?? allEntities.find((e) => link.effect.includes(e.name));
      if (fromEntity && toEntity && fromEntity.id !== toEntity.id) {
        relations.push({ from: fromEntity.id, to: toEntity.id, type: "causes", weight: link.confidence });
      }
    }
    for (const conflict of result.conflicts) {
      const entityA = newEntities.find((e) => conflict.partyA.includes(e.name));
      const entityB = newEntities.find((e) => conflict.partyB.includes(e.name));
      if (entityA && entityB) {
        relations.push({ from: entityA.id, to: entityB.id, type: "conflict", weight: 0.7 });
      }
    }
    const seen = /* @__PURE__ */ new Set();
    const unique = relations.filter((r) => {
      const key = `${r.from}:${r.to}:${r.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    relations.length = 0;
    relations.push(...unique);
  }
}
const LEARNING_RATE = 0.05;
const MIN_W = 0.05;
const MAX_W = 0.5;
class SelfEvolutionEngine {
  store;
  constructor(store) {
    this.store = store;
  }
  getCurrentParams() {
    return this.store.readEvolutionParams() ?? { ...DEFAULT_EVOLUTION_PARAMS };
  }
  async applyFeedback(signal) {
    this.store.saveFeedback(signal);
    const params = this.getCurrentParams();
    this.applyGradient(params, { dimension: signal.dimension, value: signal.value });
    params.version++;
    params.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.store.saveEvolutionParams(params);
    Logger.log("INFO", "self_evo_applied", { dimension: signal.dimension, value: signal.value, version: params.version });
    return params;
  }
  async batchUpdate(signals) {
    if (signals.length === 0) return this.getCurrentParams();
    const params = this.getCurrentParams();
    const dims = ["usefulness", "novelty", "correctness"];
    for (const dim of dims) {
      const filtered = signals.filter((s) => s.dimension === dim);
      if (filtered.length === 0) continue;
      const avg = filtered.reduce((s, f) => s + f.value, 0) / filtered.length;
      this.applyGradient(params, { dimension: dim, value: avg });
    }
    this.normalizeWeights(params);
    params.version++;
    params.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.store.saveEvolutionParams(params);
    Logger.log("INFO", "self_evo_batch", { signalCount: signals.length, version: params.version, weights: params.weights });
    return params;
  }
  async applyImplicitFeedback(opts) {
    const signals = [];
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    if (opts.insightSaved) signals.push({ source: "system", dimension: "usefulness", value: 0.1, topicId: "implicit", timestamp: ts });
    if (opts.dagFailed) signals.push({ source: "system", dimension: "correctness", value: -0.2, topicId: "implicit", timestamp: ts });
    if (opts.topicRepeated) signals.push({ source: "system", dimension: "novelty", value: -0.3, topicId: "implicit", timestamp: ts });
    if (opts.latencyMs && opts.latencyMs > 4 * 3600 * 1e3) {
      signals.push({
        source: "system",
        dimension: "novelty",
        value: -0.1,
        topicId: "implicit",
        timestamp: ts,
        latencyMs: opts.latencyMs
      });
    }
    if (signals.length > 0) await this.batchUpdate(signals);
  }
  /**
   * 将用户显式评分 (1-5) 转换为 feedback signal
   */
  convertUserRating(rating) {
    const valueMap = { 1: -0.5, 2: -0.2, 3: 0, 4: 0.15, 5: 0.3 };
    return {
      source: "user",
      dimension: "usefulness",
      value: valueMap[rating],
      topicId: "user_feedback",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  // ── private ──────────────────────────────────────────────
  applyGradient(params, grad) {
    const delta = grad.value * LEARNING_RATE;
    switch (grad.dimension) {
      case "usefulness":
        params.weights.alpha = this.clamp(params.weights.alpha + delta);
        break;
      case "novelty":
        params.weights.beta = this.clamp(params.weights.beta + delta);
        break;
      case "correctness":
        params.weights.epsilon = this.clamp(params.weights.epsilon + delta);
        if (grad.value < 0) params.thresholds.writingGate = parseFloat(Math.min(0.95, params.thresholds.writingGate + 0.03).toFixed(2));
        break;
    }
  }
  normalizeWeights(params) {
    const w = params.weights;
    const sum = w.alpha + w.beta + w.gamma + w.delta + w.epsilon;
    if (sum > 0) {
      w.alpha = parseFloat((w.alpha / sum).toFixed(4));
      w.beta = parseFloat((w.beta / sum).toFixed(4));
      w.gamma = parseFloat((w.gamma / sum).toFixed(4));
      w.delta = parseFloat((w.delta / sum).toFixed(4));
      w.epsilon = parseFloat((w.epsilon / sum).toFixed(4));
    }
  }
  clamp(v) {
    return parseFloat(Math.min(MAX_W, Math.max(MIN_W, v)).toFixed(4));
  }
}
const ANOMALY_THRESHOLD = 0.7;
class OutputLayer {
  store;
  constructor(store) {
    this.store = store;
  }
  computeAnomalyScore(insight) {
    const world = this.store.readWorldModel();
    const conflicts = world.narratives.filter((n) => n.title === insight.topic).length > 0 ? 0.5 : 0.2;
    const eventVelocity = world.events.length > 5 ? Math.min(1, world.events.length / 30) : 0.1;
    const uncertainties = (world.uncertainties?.length ?? 0) > 3 ? 0.6 : 0.2;
    return parseFloat(((conflicts + eventVelocity + uncertainties) / 3).toFixed(2));
  }
  async publishInsight(insight, dag, startedAt) {
    const anomalyScore = this.computeAnomalyScore(insight);
    insight.anomalyScore = anomalyScore;
    const isAnomaly = anomalyScore > ANOMALY_THRESHOLD;
    const envelope = {
      type: "daily_research",
      version: "1.0",
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      payload: insight,
      dagState: { taskId: dag.taskId, state: dag.state },
      metadata: {
        taskDurationMs: Date.now() - startedAt,
        llmCalls: insight.metadata.llmCalls,
        cycleStartedAt: dag.startedAt
      },
      isAnomaly
    };
    Logger.log("INFO", "output_insight_published", {
      topic: insight.topic,
      anomalyScore,
      isAnomaly,
      duration: `${(envelope.metadata.taskDurationMs / 1e3).toFixed(0)}s`
    });
    if (isAnomaly) {
      Logger.log("WARN", "output_anomaly_detected", { topic: insight.topic, score: anomalyScore });
    }
    return envelope;
  }
  async publishTrendReport(report) {
    return {
      type: "trend_report",
      version: "1.0",
      generatedAt: report.generatedAt,
      payload: report,
      dagState: { taskId: "", state: "COMPLETED" },
      metadata: { taskDurationMs: 0, llmCalls: 0, cycleStartedAt: report.generatedAt }
    };
  }
  exportForTelegram(envelope) {
    const p = envelope.payload;
    if (envelope.type === "daily_research" && p.sections) {
      const anomalyTag = p.anomalyScore && p.anomalyScore > ANOMALY_THRESHOLD ? " 🚨" : "";
      const parts = [`#obs — ${p.topic}${anomalyTag}
`];
      for (const s of p.sections) parts.push(`*${s.title}*
${s.content.slice(0, 800)}
`);
      const text = parts.join("\n");
      return text.length > 4096 ? text.slice(0, 4e3) + "\n\n...（截断）" : text;
    }
    return `#obs — Trend Report (${envelope.generatedAt})`;
  }
  exportForApi(envelope) {
    return envelope;
  }
}
class RSSCollector {
  name = "rss";
  intervalMs = 60 * 60 * 1e3;
  // 每 60 分钟
  feeds;
  seenUrls = /* @__PURE__ */ new Set();
  constructor(feeds) {
    this.feeds = feeds ?? [
      // 科技
      "https://feeds.feedburner.com/ruanyifeng",
      // 央视新闻
      "http://www.cctv.com/program/rss/02/01/index.xml",
      "http://www.cctv.com/program/rss/02/02/index.xml",
      "http://www.cctv.com/program/rss/02/04/index.xml",
      "http://www.cctv.com/program/rss/02/06/index.xml",
      // 人民网
      "http://www.people.com.cn/rss/politics.xml",
      "http://www.people.com.cn/rss/world.xml",
      "http://www.people.com.cn/rss/society.xml",
      // 新华网
      "http://www.xinhuanet.com/politics/news_politics.xml",
      "http://www.xinhuanet.com/world/news_world.xml",
      "http://www.xinhuanet.com/tech/news_tech.xml",
      "http://www.xinhuanet.com/fortune/news_fortune.xml",
      // RSSHub 代理（澎湃 / 财新）
      "https://rsshub.app/thepaper/featured",
      "https://rsshub.app/caixin/latest",
      // 技术资讯
      "https://feeds.feedburner.com/InfoqChinese",
      "https://www.jiqizhixin.com/rss",
      "https://36kr.com/feed"
    ];
  }
  async collect() {
    const now = /* @__PURE__ */ new Date();
    const ts = now.toISOString();
    const all = [];
    let idCounter = 0;
    for (const feedUrl of this.feeds) {
      try {
        const items = await this.fetchFeed(feedUrl);
        for (const item of items) {
          const url = item.link || item.title || "";
          if (url && this.seenUrls.has(url)) continue;
          if (url) this.seenUrls.add(url);
          const content = item.title || stripHtml$1(item.description || "");
          if (!content || content.length < 5) continue;
          all.push({
            id: `rss_${now.getTime()}_${idCounter++}`,
            timestamp: item.pubDate || ts,
            source: feedUrl,
            content: content.slice(0, 200)
          });
        }
      } catch (err) {
        Logger.log("WARN", "rss_collect_failed", { feed: feedUrl, error: err.message });
      }
    }
    if (this.seenUrls.size > 1e4) {
      this.seenUrls = new Set([...this.seenUrls].slice(-5e3));
    }
    Logger.log("INFO", "rss_collected", { feeds: this.feeds.length, new_items: all.length });
    return all;
  }
  async fetchFeed(feedUrl) {
    const services = [`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`];
    for (const serviceUrl of services) {
      try {
        const res = await fetch(serviceUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(15e3)
        });
        if (!res.ok) continue;
        const json = await res.json();
        if (json?.items && Array.isArray(json.items)) {
          return json.items.map((item) => ({
            title: item.title,
            link: item.link || item.guid || "",
            description: item.description || item.content,
            pubDate: item.pubDate || item.date
          }));
        }
      } catch {
        continue;
      }
    }
    return [];
  }
}
function stripHtml$1(text) {
  return text.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
class BilibiliCollector {
  name = "bilibili";
  intervalMs = 60 * 60 * 1e3;
  headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: "https://www.bilibili.com/"
  };
  async collect() {
    const now = /* @__PURE__ */ new Date();
    const ts = now.toISOString();
    const all = [];
    try {
      const res = await fetch("https://s.search.bilibili.com/main/hotword", {
        headers: this.headers,
        signal: AbortSignal.timeout(1e4)
      });
      if (res.ok) {
        const data = await res.json();
        const list = data?.data?.list ?? [];
        all.push(
          ...list.slice(0, 15).map((item, i) => ({
            id: `bili_hot_${now.getTime()}_${i}`,
            timestamp: ts,
            source: this.name,
            content: item.show_name || item.keyword
          }))
        );
      }
    } catch (err) {
      Logger.log("WARN", "bili_hotword_failed", { error: err.message });
    }
    try {
      const res = await fetch("https://api.bilibili.com/x/web-interface/popular?ps=10&pn=1", {
        headers: this.headers,
        signal: AbortSignal.timeout(1e4)
      });
      if (res.ok) {
        const data = await res.json();
        const list = data?.data?.list ?? [];
        all.push(
          ...list.map((v, i) => ({
            id: `bili_pop_${now.getTime()}_${i}`,
            timestamp: ts,
            source: this.name,
            content: `【B站热门】${v.title}`
          }))
        );
      }
    } catch (err) {
      Logger.log("WARN", "bili_popular_failed", { error: err.message });
    }
    Logger.log("INFO", "bili_collected", { total: all.length });
    return all;
  }
}
class DouyinCollector {
  name = "douyin";
  intervalMs = 60 * 60 * 1e3;
  apis = ["https://60s.viki.moe/v2/douyin", "https://hot.imsyy.top/douyin"];
  async collect() {
    const now = /* @__PURE__ */ new Date();
    const ts = now.toISOString();
    for (const url of this.apis) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1e4) });
        if (!res.ok) continue;
        const body = await res.json();
        const list = body?.data ?? [];
        if (list.length === 0) continue;
        const obs = list.slice(0, 20).map((item, i) => ({
          id: `douyin_${now.getTime()}_${i}`,
          timestamp: ts,
          source: this.name,
          content: `【抖音热点】${item.title}`
        }));
        Logger.log("INFO", "douyin_collected", { count: obs.length });
        return obs;
      } catch (err) {
        Logger.log("WARN", "douyin_failed", { url, error: err.message });
      }
    }
    return [];
  }
}
class GitHubTrendingCollector {
  name = "github-trending";
  intervalMs = 4 * 60 * 60 * 1e3;
  async collect() {
    const now = /* @__PURE__ */ new Date();
    const ts = now.toISOString();
    try {
      const res = await fetch("https://hot.imsyy.top/hellogithub", { signal: AbortSignal.timeout(1e4) });
      if (res.ok) {
        const body = await res.json();
        const list = body?.data ?? [];
        if (list.length > 0) {
          Logger.log("INFO", "gh_trending_collected", { count: list.length });
          return list.slice(0, 15).map((item, i) => ({
            id: `gh_${now.getTime()}_${i}`,
            timestamp: ts,
            source: this.name,
            content: `【GitHub】${item.title} ⭐${item.stars ?? "?"} — ${(item.description || "").slice(0, 100)}`
          }));
        }
      }
    } catch (err) {
      Logger.log("WARN", "gh_trending_api_failed", { error: err.message });
    }
    try {
      const res = await fetch("https://github.com/trending?since=daily", {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15e3)
      });
      if (!res.ok) return [];
      const html = await res.text();
      const repos = [];
      const articleRegex = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
      let idx = 0, m;
      while ((m = articleRegex.exec(html)) !== null && repos.length < 15) {
        const a = m[1];
        const title = a.match(/href="\/([^"]+)"/);
        const desc = a.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        const stars = a.match(/octicon-star[\s\S]*?<span[^>]*class="[^"]*d-inline-block[^"]*"[^>]*>([\s\S]*?)<\/span>/);
        if (title)
          repos.push({
            id: `gh_${now.getTime()}_${idx++}`,
            timestamp: ts,
            source: this.name,
            content: `【GitHub】${title[1].trim()} ⭐${stars ? stars[1].trim() : "?"} — ${desc ? stripHtml(desc[1]).slice(0, 100) : ""}`
          });
      }
      if (repos.length > 0) {
        Logger.log("INFO", "gh_trending_scraped", { count: repos.length });
        return repos;
      }
    } catch (err) {
      Logger.log("WARN", "gh_trending_scrape_failed", { error: err.message });
    }
    return [];
  }
}
function stripHtml(text) {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
class HackerNewsCollector {
  name = "hackernews";
  intervalMs = 60 * 60 * 1e3;
  // 每 60 分钟
  seenUrls = /* @__PURE__ */ new Set();
  async collect() {
    const now = /* @__PURE__ */ new Date();
    now.toISOString();
    const all = [];
    try {
      const idsRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
        signal: AbortSignal.timeout(15e3)
      });
      if (!idsRes.ok) {
        Logger.log("WARN", "hn_fetch_ids_failed", { status: idsRes.status });
        return [];
      }
      const ids = await idsRes.json();
      const topIds = ids.slice(0, 30);
      const batchSize = 10;
      for (let i = 0; i < topIds.length; i += batchSize) {
        const batch = topIds.slice(i, i + batchSize);
        const stories = await Promise.all(
          batch.map(
            (id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
              signal: AbortSignal.timeout(1e4)
            }).then((r) => r.ok ? r.json() : null).catch(() => null)
          )
        );
        for (const story of stories) {
          if (!story || story.type !== "story" || !story.title) continue;
          const url = story.url || `https://news.ycombinator.com/item?id=${story.id}`;
          if (this.seenUrls.has(url)) continue;
          this.seenUrls.add(url);
          const points = story.score ?? 0;
          const by = story.by ?? "unknown";
          all.push({
            id: `hn_${now.getTime()}_${story.id}`,
            timestamp: new Date((story.time || 0) * 1e3).toISOString(),
            source: "hackernews",
            content: `${story.title} (${points} points by ${by})`.slice(0, 200)
          });
        }
      }
    } catch (err) {
      Logger.log("WARN", "hn_collect_failed", { error: err.message });
    }
    if (this.seenUrls.size > 1e4) {
      this.seenUrls = new Set([...this.seenUrls].slice(-5e3));
    }
    Logger.log("INFO", "hn_collected", { new_items: all.length });
    return all;
  }
}
const PIPELINE_INTERVAL_MS = 4 * 60 * 60 * 1e3;
class ObserverService {
  // legacy
  llm;
  store;
  fermentation;
  writingGate;
  collectors;
  // pipeline
  dag;
  trend;
  tension;
  research;
  multiBrain;
  composer;
  worldModel;
  selfEvo;
  output;
  collectorTimers = [];
  pipelineTimer = null;
  disposed = false;
  lastPipelineDate = "";
  pipelineRunning = false;
  constructor(baseDir) {
    this.llm = new ObserverLlmService();
    this.store = new ObserverStore(baseDir);
    this.fermentation = new FermentationEngine(this.llm, this.store);
    this.writingGate = new WritingGate(this.llm, this.store);
    this.dag = new DagStateMachine(this.store.baseDir);
    this.trend = new TrendEngine(this.llm, this.store);
    this.tension = new TensionFieldEngine(this.llm, this.store);
    this.research = new DeepResearchEngine(this.llm, this.store);
    this.multiBrain = new MultiBrainModel(this.llm);
    this.composer = new InsightComposer(this.llm, this.store);
    this.worldModel = new WorldModelStore(this.llm, this.store);
    this.selfEvo = new SelfEvolutionEngine(this.store);
    this.output = new OutputLayer(this.store);
    this.collectors = [
      new RSSCollector(),
      new BilibiliCollector(),
      new DouyinCollector(),
      new GitHubTrendingCollector(),
      new HackerNewsCollector()
    ];
  }
  // ════════════════════════════════════════════════════════════
  // 原公共接口
  // ════════════════════════════════════════════════════════════
  addCollector(collector) {
    this.collectors.push(collector);
  }
  getLlm() {
    return this.llm;
  }
  getFermentation() {
    return this.fermentation;
  }
  // ════════════════════════════════════════════════════════════
  // 新公共接口
  // ════════════════════════════════════════════════════════════
  getDag() {
    return this.dag;
  }
  getTrend() {
    return this.trend;
  }
  getWorldModel() {
    return this.worldModel;
  }
  getSelfEvo() {
    return this.selfEvo;
  }
  async submitFeedback(signal) {
    return this.selfEvo.applyFeedback(signal);
  }
  async runPipeline(mode = "analytical") {
    if (this.pipelineRunning) {
      Logger.log("WARN", "pipeline_already_running");
      return null;
    }
    this.pipelineRunning = true;
    const startedAt = Date.now();
    const logTag = `pipe_${(/* @__PURE__ */ new Date()).toISOString().slice(11, 19)}`;
    try {
      let dag = this.dag.createTask();
      if (dag.state === "COMPLETED") {
        this.lastPipelineDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        return null;
      }
      await this.forceCollect();
      dag = this.dag.transition(dag, "COLLECTED");
      Logger.log("INFO", `${logTag}_trend`);
      const trends = await this.trend.detectTrends();
      dag = this.dag.transition(dag, "TOPIC_SELECTED");
      Logger.log("INFO", `${logTag}_tension`);
      const topicSelection = await this.tension.selectTopic(trends);
      dag = this.dag.transition(dag, "RESEARCHING");
      Logger.log("INFO", `${logTag}_research`);
      const obs = this.store.readRecent(3).map((o) => `[${o.source}] ${o.content}`);
      const researchResult = await this.research.research(topicSelection.topic, obs);
      dag = this.dag.transition(dag, "ANALYZING");
      Logger.log("INFO", `${logTag}_brain`);
      const brainOutputs = await this.multiBrain.process(researchResult, mode);
      dag = this.dag.transition(dag, "WRITING");
      Logger.log("INFO", `${logTag}_compose`);
      const insight = await this.composer.compose(topicSelection.topic, researchResult, brainOutputs, mode);
      dag = this.dag.transition(dag, "STORED");
      Logger.log("INFO", `${logTag}_world_model`);
      await this.worldModel.update(researchResult, insight);
      Logger.log("INFO", `${logTag}_output`);
      const envelope = await this.output.publishInsight(insight, dag, startedAt);
      dag = this.dag.transition(dag, "COMPLETED");
      const repeated = this.store.getRecentTopics(7).length > 3;
      await this.selfEvo.applyImplicitFeedback({ insightSaved: true, dagFailed: false, topicRepeated: repeated });
      this.lastPipelineDate = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      Logger.log("INFO", "pipeline_completed", {
        taskId: dag.taskId,
        topic: insight.topic,
        sections: insight.sections.length,
        durationSec: ((Date.now() - startedAt) / 1e3).toFixed(0)
      });
      return envelope;
    } catch (err) {
      Logger.log("ERROR", "pipeline_failed", { error: err.message });
      try {
        const d = this.dag.getTodayTask();
        if (d) this.dag.failTask(d, { message: err.message, phase: "pipeline" });
      } catch {
      }
      return null;
    } finally {
      this.pipelineRunning = false;
    }
  }
  // ════════════════════════════════════════════════════════════
  // start / stop
  // ════════════════════════════════════════════════════════════
  async start() {
    if (this.disposed) return;
    Logger.log("INFO", "observer_service_start");
    for (const collector of this.collectors) {
      const timer = setInterval(async () => {
        const obs = await collector.collect();
        this.store.store(obs);
      }, collector.intervalMs);
      this.collectorTimers.push(timer);
      collector.collect().then((obs) => this.store.store(obs));
    }
    this.pipelineTimer = setInterval(() => this.tickPipeline(), 6e4);
    setTimeout(() => this.tickPipeline(), 5e3);
    Logger.log("INFO", "observer_service_started", {
      collectors: this.collectors.length,
      pipeline_interval_hours: PIPELINE_INTERVAL_MS / 36e5
    });
  }
  stop() {
    this.disposed = true;
    for (const t of this.collectorTimers) clearInterval(t);
    this.collectorTimers = [];
    if (this.pipelineTimer) {
      clearInterval(this.pipelineTimer);
      this.pipelineTimer = null;
    }
    this.llm.dispose();
    Logger.log("INFO", "observer_service_stopped");
  }
  async forceCollect() {
    for (const c of this.collectors) {
      const obs = await c.collect();
      this.store.store(obs);
    }
  }
  async forceFerment() {
    const result = await this.fermentation.ferment("afternoon");
    if (result.clusters.length > 0) {
      const path2 = await this.writingGate.tryWrite(result);
      if (path2) Logger.log("INFO", "observer_essay_written", { path: path2 });
    }
  }
  async forcePipeline(mode = "analytical") {
    return this.runPipeline(mode);
  }
  // ── private ──────────────────────────────────────────────
  async tickPipeline() {
    if (this.disposed || this.pipelineRunning) return;
    const today2 = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    if (this.lastPipelineDate === today2 && this.dag.isTodayCompleted()) return;
    await this.runPipeline("analytical");
  }
}
exports.ObserverService = ObserverService;
