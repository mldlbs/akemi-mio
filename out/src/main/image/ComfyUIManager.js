/**
 * ComfyUIManager — ComfyUI 子进程 / HTTP API 管理器
 *
 * 职责：
 * - 管理 ComfyUI 进程生命周期（启动/停止/健康检查）
 * - 提供 generate() API 供 ImageGenerationTool 调用
 * - 管理 FLUX.1-schnell workflow 加载
 * - GPU 资源协调（检测 ASR 是否正在使用 GPU）
 */
import { log } from '../logger/Logger';
import { eventBus } from '../core/EventBus';
import { WORKSPACE } from '../config';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
const DEFAULT_CONFIG = {
    root: process.env.COMFYUI_ROOT || join(WORKSPACE.cache, 'comfyui'),
    port: 8188,
    startupTimeoutMs: 60000,
    generateTimeoutMs: 120000,
    autoRestart: true,
};
const WORKFLOW_JSON_PATH = 'workflows/flux_pulid_api.json';
const WORKFLOW_REF_IMAGE_NODE = '1'; // LoadImage node ID
const WORKFLOW_POSITIVE_NODE = '8'; // CLIPTextEncode (positive)
const WORKFLOW_NEGATIVE_NODE = '9'; // CLIPTextEncode (negative)
// ─── ComfyUIManager ───
export class ComfyUIManager {
    constructor(config) {
        this.process = null;
        this.ready = false;
        this.starting = false;
        this.healthy = false;
        this.healthCheckTimer = null;
        this.restartAttempts = 0;
        this.MAX_RESTART_ATTEMPTS = 3;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.outputsDir = join(this.config.root, 'output');
        if (!existsSync(this.outputsDir)) {
            mkdirSync(this.outputsDir, { recursive: true });
        }
    }
    // ───── 生命周期 ─────
    get isReady() {
        return this.ready;
    }
    get isHealthy() {
        return this.healthy;
    }
    async start() {
        if (this.ready || this.starting)
            return;
        this.starting = true;
        if (!existsSync(this.config.root)) {
            log('WARN', 'comfyui_root_not_found', { root: this.config.root });
            log('INFO', 'comfyui_skip', {
                reason: '请自行安装 ComfyUI 到 ' + this.config.root + ' 或设置 COMFYUI_ROOT 环境变量',
            });
            this.starting = false;
            return;
        }
        const mainPy = join(this.config.root, 'main.py');
        if (!existsSync(mainPy)) {
            log('WARN', 'comfyui_main_not_found', { path: mainPy });
            this.starting = false;
            return;
        }
        try {
            log('INFO', 'comfyui_starting', { root: this.config.root, port: this.config.port });
            this.process = spawn('python', ['main.py', '--port', String(this.config.port), '--listen', '0.0.0.0', '--highvram'], {
                cwd: this.config.root,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env },
            });
            this.process.stdout?.on('data', (data) => {
                const text = data.toString();
                if (text.includes('Starting server')) {
                    log('INFO', 'comfyui_server_starting');
                }
                if (text.includes('To see the ui go to')) {
                    this.onReady();
                }
            });
            this.process.stderr?.on('data', (data) => {
                const text = data.toString();
                if (text.includes('Prompt outputs')) {
                    this.onReady();
                }
                if (text.toLowerCase().includes('error') || text.toLowerCase().includes('traceback')) {
                    log('WARN', 'comfyui_stderr', { msg: text.trim().slice(0, 200) });
                }
            });
            this.process.on('exit', (code, signal) => {
                log('WARN', 'comfyui_exit', { code, signal });
                this.ready = false;
                this.healthy = false;
                this.process = null;
                this.starting = false;
                if (this.config.autoRestart && this.restartAttempts < this.MAX_RESTART_ATTEMPTS) {
                    this.restartAttempts++;
                    log('INFO', 'comfyui_restart', { attempt: this.restartAttempts });
                    setTimeout(() => this.start(), 5000);
                }
            });
            this.process.on('error', (err) => {
                log('ERROR', 'comfyui_process_error', { error: err.message });
                this.ready = false;
                this.starting = false;
            });
            setTimeout(() => {
                if (!this.ready) {
                    log('WARN', 'comfyui_start_timeout', { timeoutMs: this.config.startupTimeoutMs });
                    this.starting = false;
                }
            }, this.config.startupTimeoutMs);
            this.startHealthCheck();
        }
        catch (err) {
            log('ERROR', 'comfyui_start_failed', { error: err.message });
            this.starting = false;
        }
    }
    async stop() {
        this.config.autoRestart = false;
        this.stopHealthCheck();
        if (this.process) {
            this.process.kill('SIGTERM');
            setTimeout(() => {
                if (this.process)
                    this.process.kill('SIGKILL');
            }, 5000);
            this.process = null;
        }
        this.ready = false;
        this.healthy = false;
        log('INFO', 'comfyui_stopped');
    }
    // ───── 图片生成 ─────
    async generate(opts) {
        if (!this.ready)
            throw new Error('ComfyUI 未就绪');
        const t0 = Date.now();
        const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
        const width = opts.width ?? 1024;
        const height = opts.height ?? 1024;
        const workflow = this.loadWorkflow({
            prompt: opts.prompt,
            negativePrompt: opts.negativePrompt,
            seed,
            width,
            height,
            refImage: opts.refImage,
        });
        try {
            const queueRes = await fetch(`http://127.0.0.1:${this.config.port}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflow }),
                signal: AbortSignal.timeout(30000),
            });
            if (!queueRes.ok) {
                const errBody = await queueRes.text().catch(() => '');
                throw new Error(`ComfyUI prompt 提交失败 (${queueRes.status}): ${errBody.slice(0, 300)}`);
            }
            const queueData = (await queueRes.json());
            const imagePath = await this.pollResult(queueData.prompt_id, t0);
            return { success: true, imagePath, seed, elapsedMs: Date.now() - t0 };
        }
        catch (err) {
            throw new Error(`ComfyUI 生成失败: ${err.message}`);
        }
    }
    // ───── 内部 ─────
    onReady() {
        if (this.ready)
            return;
        this.ready = true;
        this.starting = false;
        this.healthy = true;
        this.restartAttempts = 0;
        log('INFO', 'comfyui_ready', { port: this.config.port });
        eventBus.emit('comfyui.ready', { port: this.config.port });
    }
    startHealthCheck() {
        this.stopHealthCheck();
        this.healthCheckTimer = setInterval(async () => {
            try {
                const res = await fetch(`http://127.0.0.1:${this.config.port}/system_stats`, {
                    signal: AbortSignal.timeout(5000),
                });
                this.healthy = res.ok;
                if (!this.ready && res.ok)
                    this.onReady();
            }
            catch {
                this.healthy = false;
            }
        }, 15000);
    }
    stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
    async pollResult(promptId, startTime) {
        while (Date.now() - startTime < this.config.generateTimeoutMs) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
                const res = await fetch(`http://127.0.0.1:${this.config.port}/history/${promptId}`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (!res.ok)
                    continue;
                const history = (await res.json());
                const entry = history[promptId];
                if (!entry?.outputs)
                    continue;
                for (const nodeId of Object.keys(entry.outputs)) {
                    const nodeOutput = entry.outputs[nodeId];
                    if (nodeOutput.images) {
                        for (const img of nodeOutput.images) {
                            if (img.type === 'output') {
                                const imgPath = join(this.outputsDir, img.subfolder || '', img.filename);
                                if (existsSync(imgPath))
                                    return imgPath;
                            }
                        }
                    }
                }
            }
            catch {
                // 网络错误直接重试
            }
        }
        throw new Error(`ComfyUI 生成超时 (${this.config.generateTimeoutMs / 1000}s)`);
    }
    loadWorkflow(opts) {
        const { prompt, negativePrompt, seed, width, height, refImage } = opts;
        const wfPath = join(this.config.root, WORKFLOW_JSON_PATH);
        if (existsSync(wfPath)) {
            const workflow = JSON.parse(readFileSync(wfPath, 'utf-8'));
            this.overrideWorkflowPrompt(workflow, { prompt, negativePrompt, seed, refImage });
            // 如果 JSON workflow 没有 refImage 节点，用回硬编码
            if (refImage && workflow[WORKFLOW_REF_IMAGE_NODE]) {
                workflow[WORKFLOW_REF_IMAGE_NODE].inputs.image = refImage;
            }
            return workflow;
        }
        return this.buildDefaultWorkflow(prompt, seed, width, height);
    }
    overrideWorkflowPrompt(workflow, opts) {
        const { prompt, negativePrompt, seed } = opts;
        for (const nodeId of Object.keys(workflow)) {
            const node = workflow[nodeId];
            if (!node?.inputs)
                continue;
            const cls = node.class_type;
            if (cls === 'CLIPTextEncode' && typeof node.inputs.text === 'string') {
                if (nodeId === WORKFLOW_NEGATIVE_NODE && negativePrompt) {
                    node.inputs.text = negativePrompt;
                }
                else if (nodeId === WORKFLOW_POSITIVE_NODE) {
                    node.inputs.text = prompt;
                }
            }
            if (cls === 'KSampler' || cls === 'KSamplerAdvanced' || cls === 'SamplerCustom') {
                if (typeof node.inputs.seed === 'number')
                    node.inputs.seed = seed;
            }
            if (cls === 'RandomNoise') {
                if (typeof node.inputs.noise_seed === 'number')
                    node.inputs.noise_seed = seed;
            }
            // 覆盖 refImage
            if (cls === 'LoadImage' && nodeId === WORKFLOW_REF_IMAGE_NODE && opts.refImage) {
                node.inputs.image = opts.refImage;
            }
        }
    }
    buildDefaultWorkflow(prompt, seed, width, height) {
        return {
            '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['11', 0] }, _meta: { title: 'Positive' } },
            '4': {
                class_type: 'KSampler',
                inputs: {
                    seed,
                    steps: 4,
                    cfg: 1,
                    sampler_name: 'euler',
                    scheduler: 'simple',
                    denoise: 1,
                    model: ['10', 0],
                    positive: ['3', 0],
                    negative: ['7', 0],
                    latent_image: ['12', 0],
                },
                _meta: { title: 'KSampler' },
            },
            '7': {
                class_type: 'CLIPTextEncode',
                inputs: { text: 'blurry, low quality, distorted', clip: ['11', 0] },
                _meta: { title: 'Negative' },
            },
            '8': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['13', 0] }, _meta: { title: 'VAEDecode' } },
            '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'akemi_mio' }, _meta: { title: 'SaveImage' } },
            '10': {
                class_type: 'UnetLoaderGGUF',
                inputs: { unet_name: 'flux-schnell\\' + 'flux1-schnell-Q4_K_S.gguf' },
                _meta: { title: 'Load FLUX GGUF' },
            },
            '11': {
                class_type: 'DualCLIPLoaderGGUF',
                inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5-v1_1-xxl-encoder-Q6_K.gguf', type: 'flux' },
            },
            '12': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 }, _meta: { title: 'Empty Latent' } },
            '13': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' }, _meta: { title: 'Load VAE' } },
        };
    }
}
