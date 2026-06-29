import { log } from '../logger/Logger';
import { ObserverLlmService } from './ObserverLlmService';
import { ObserverStore } from './ObserverStore';
import { FermentationEngine } from './FermentationEngine';
import { WritingGate } from './WritingGate';
import { DagStateMachine } from './DagStateMachine';
import { TrendEngine } from './TrendEngine';
import { TensionFieldEngine } from './TensionFieldEngine';
import { DeepResearchEngine } from './DeepResearchEngine';
import { MultiBrainModel } from './MultiBrainModel';
import { InsightComposer } from './InsightComposer';
import { WorldModelStore } from './WorldModelStore';
import { SelfEvolutionEngine } from './SelfEvolutionEngine';
import { OutputLayer } from './OutputLayer';
import { RSSCollector } from './collectors/RSSCollector';
import { BilibiliCollector } from './collectors/BilibiliCollector';
import { DouyinCollector } from './collectors/DouyinCollector';
import { GitHubTrendingCollector } from './collectors/GitHubTrendingCollector';
import { HackerNewsCollector } from './collectors/HackerNewsCollector';
const PIPELINE_INTERVAL_MS = 4 * 60 * 60 * 1000;
/**
 * ObserverService — 观察者服务（升级版）
 *
 * 混合模式：同时支持 legacy 发酵和新的 DAG 驱动 pipeline。
 * - collectors 独立运行定时采集
 * - legacy ferment 保留（forceFerment 向后兼容）
 * - pipeline 每 4 小时执行一次完整 DAG
 */
export class ObserverService {
    constructor(baseDir) {
        this.collectorTimers = [];
        this.pipelineTimer = null;
        this.disposed = false;
        this.lastPipelineDate = '';
        this.pipelineRunning = false;
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
            new HackerNewsCollector(),
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
    async runPipeline(mode = 'analytical') {
        if (this.pipelineRunning) {
            log('WARN', 'pipeline_already_running');
            return null;
        }
        this.pipelineRunning = true;
        const startedAt = Date.now();
        const logTag = `pipe_${new Date().toISOString().slice(11, 19)}`;
        try {
            let dag = this.dag.createTask();
            if (dag.state === 'COMPLETED') {
                this.lastPipelineDate = new Date().toISOString().slice(0, 10);
                return null;
            }
            // Step 1: Collect
            await this.forceCollect();
            dag = this.dag.transition(dag, 'COLLECTED');
            // Step 2: Trend
            log('INFO', `${logTag}_trend`);
            const trends = await this.trend.detectTrends();
            dag = this.dag.transition(dag, 'TOPIC_SELECTED');
            // Step 3: Tension
            log('INFO', `${logTag}_tension`);
            const topicSelection = await this.tension.selectTopic(trends);
            dag = this.dag.transition(dag, 'RESEARCHING');
            // Step 4: Deep Research
            log('INFO', `${logTag}_research`);
            const obs = this.store.readRecent(3).map((o) => `[${o.source}] ${o.content}`);
            const researchResult = await this.research.research(topicSelection.topic, obs);
            dag = this.dag.transition(dag, 'ANALYZING');
            // Step 5: Multi-Brain
            log('INFO', `${logTag}_brain`);
            const brainOutputs = await this.multiBrain.process(researchResult, mode);
            dag = this.dag.transition(dag, 'WRITING');
            // Step 6: Compose
            log('INFO', `${logTag}_compose`);
            const insight = await this.composer.compose(topicSelection.topic, researchResult, brainOutputs, mode);
            dag = this.dag.transition(dag, 'STORED');
            // Step 7: World Model
            log('INFO', `${logTag}_world_model`);
            await this.worldModel.update(researchResult, insight);
            // Step 8: Output
            log('INFO', `${logTag}_output`);
            const envelope = await this.output.publishInsight(insight, dag, startedAt);
            dag = this.dag.transition(dag, 'COMPLETED');
            // Step 9: Self Evolution
            const repeated = this.store.getRecentTopics(7).length > 3;
            await this.selfEvo.applyImplicitFeedback({ insightSaved: true, dagFailed: false, topicRepeated: repeated });
            this.lastPipelineDate = new Date().toISOString().slice(0, 10);
            log('INFO', 'pipeline_completed', {
                taskId: dag.taskId,
                topic: insight.topic,
                sections: insight.sections.length,
                durationSec: ((Date.now() - startedAt) / 1000).toFixed(0),
            });
            return envelope;
        }
        catch (err) {
            log('ERROR', 'pipeline_failed', { error: err.message });
            try {
                const d = this.dag.getTodayTask();
                if (d)
                    this.dag.failTask(d, { message: err.message, phase: 'pipeline' });
            }
            catch { }
            return null;
        }
        finally {
            this.pipelineRunning = false;
        }
    }
    // ════════════════════════════════════════════════════════════
    // start / stop
    // ════════════════════════════════════════════════════════════
    async start() {
        if (this.disposed)
            return;
        log('INFO', 'observer_service_start');
        for (const collector of this.collectors) {
            const timer = setInterval(async () => {
                const obs = await collector.collect();
                this.store.store(obs);
            }, collector.intervalMs);
            this.collectorTimers.push(timer);
            collector.collect().then((obs) => this.store.store(obs));
        }
        this.pipelineTimer = setInterval(() => this.tickPipeline(), 60000);
        setTimeout(() => this.tickPipeline(), 5000);
        log('INFO', 'observer_service_started', {
            collectors: this.collectors.length,
            pipeline_interval_hours: PIPELINE_INTERVAL_MS / 3600000,
        });
    }
    stop() {
        this.disposed = true;
        for (const t of this.collectorTimers)
            clearInterval(t);
        this.collectorTimers = [];
        if (this.pipelineTimer) {
            clearInterval(this.pipelineTimer);
            this.pipelineTimer = null;
        }
        this.llm.dispose();
        log('INFO', 'observer_service_stopped');
    }
    async forceCollect() {
        for (const c of this.collectors) {
            const obs = await c.collect();
            this.store.store(obs);
        }
    }
    async forceFerment() {
        const result = await this.fermentation.ferment('afternoon');
        if (result.clusters.length > 0) {
            const path = await this.writingGate.tryWrite(result);
            if (path)
                log('INFO', 'observer_essay_written', { path });
        }
    }
    async forcePipeline(mode = 'analytical') {
        return this.runPipeline(mode);
    }
    // ── private ──────────────────────────────────────────────
    async tickPipeline() {
        if (this.disposed || this.pipelineRunning)
            return;
        const today = new Date().toISOString().slice(0, 10);
        if (this.lastPipelineDate === today && this.dag.isTodayCompleted())
            return;
        await this.runPipeline('analytical');
    }
}
