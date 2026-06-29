import { log, createRequestId } from '../logger/Logger';
import { WhisperEngine } from './WhisperEngine';
/** 检查识别结果是否有意义：有效字符占比过低则判定为乱码 */
function isGarbled(text) {
    if (!text || text.length === 0)
        return true;
    let valid = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if ((code >= 0x20 && code <= 0x7e) ||
            (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0x3000 && code <= 0x303f) ||
            (code >= 0xff00 && code <= 0xffef)) {
            valid++;
        }
    }
    return valid / text.length < 0.6;
}
const NOISE_PATTERNS = [
    /^\(.*\)$/, // 括号包裹的噪音幻觉，如 (字幕制作:贝尔)
    /^[\p{P}\p{S}\s]+$/u, // 纯标点符号
];
// Whisper 在静音/底噪下高频幻觉出的社交结束语
const WHISPER_HALLUCINATIONS = [
    /^谢谢大家$/,
    /^谢谢\s*$/,
    /^感谢\s*$/,
    /^感谢大家$/,
    /^再会\s*$/,
    /^再见\s*$/,
    /^谢谢观看\s*$/,
    /^感谢收听\s*$/,
    /^谢谢收看\s*$/,
    /^感谢观看\s*$/,
];
function isNoise(text) {
    if (!text || !text.trim())
        return true;
    const trimmed = text.trim();
    if (trimmed.length <= 1)
        return true;
    if (/^\?+$/.test(trimmed))
        return true;
    for (const pattern of NOISE_PATTERNS) {
        if (pattern.test(trimmed))
            return true;
    }
    for (const pattern of WHISPER_HALLUCINATIONS) {
        if (pattern.test(trimmed))
            return true;
    }
    return false;
}
export class AsrService {
    constructor(gpuEngine, baiduEngine) {
        this.cpuEngine = null;
        this.cpuInitPromise = null;
        this._pendingRequests = 0;
        this.gpuEngine = gpuEngine;
        this.baiduEngine = baiduEngine;
    }
    isCorrupted(text) {
        return isGarbled(text);
    }
    async initCpuFallback() {
        if (this.cpuEngine)
            return;
        if (this.cpuInitPromise)
            return this.cpuInitPromise;
        this.cpuInitPromise = (async () => {
            const engine = new WhisperEngine();
            await engine.initialize('tiny');
            this.cpuEngine = engine;
            log('INFO', 'cpu_asr_fallback_ready');
        })();
        return this.cpuInitPromise;
    }
    setBaiduCredentials(apiKey, secretKey) {
        this.baiduApiKey = apiKey;
        this.baiduSecretKey = secretKey;
    }
    get useBaidu() {
        return !!(this.baiduApiKey && this.baiduSecretKey);
    }
    get pendingRequests() {
        return this._pendingRequests;
    }
    async transcribe(audioBuffer, requestId) {
        const rid = requestId || createRequestId();
        this._pendingRequests++;
        // 使用 try/finally 确保计数器在任何路径下都会递减，防止泄漏
        const decrement = () => {
            this._pendingRequests = Math.max(0, this._pendingRequests - 1);
        };
        try {
            if (this._pendingRequests > 1) {
                log('WARN', 'queue_status', {
                    request_id: rid,
                    pending_requests: this._pendingRequests,
                    warning: 'concurrent ASR requests detected',
                });
            }
            // 1. GPU Whisper（Vulkan 加速，RTX 3060）
            if (this.gpuEngine.getStatus().loaded) {
                try {
                    const samples = new Int16Array(audioBuffer);
                    const float32 = new Float32Array(samples.length);
                    for (let i = 0; i < samples.length; i++)
                        float32[i] = samples[i] / 32768;
                    const result = await this.gpuEngine.transcribe(float32, 15000);
                    // GPU 输出编码损坏时降级到 CPU whisper 重新识别
                    if (this.isCorrupted(result.text)) {
                        log('WARN', 'gpu_asr_utf8_corrupted', {
                            request_id: rid,
                            text: result.text,
                            ratio: (result.text.match(/�/g) || []).length / result.text.length,
                        });
                        try {
                            await this.initCpuFallback();
                            if (this.cpuEngine) {
                                const cpuResult = await this.cpuEngine.transcribe(float32, 20000, rid);
                                return { text: cpuResult.text, request_id: rid };
                            }
                        }
                        catch (cpuErr) {
                            log('WARN', 'cpu_asr_fallback_failed', {
                                request_id: rid,
                                error: String(cpuErr),
                            });
                        }
                    }
                    if (isNoise(result.text)) {
                        log('INFO', 'asr_noise_filtered', { request_id: rid, text: result.text });
                        return { text: '', request_id: rid };
                    }
                    return { text: result.text, request_id: rid };
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log('WARN', 'gpu_asr_fallback_to_baidu', { request_id: rid, error: msg });
                }
            }
            // 2. 后备：百度 ASR（云端）
            if (this.useBaidu) {
                try {
                    const samples = new Int16Array(audioBuffer);
                    const audioLen = parseFloat((samples.length / 16000).toFixed(1));
                    const t0 = Date.now();
                    const text = await Promise.race([
                        this.baiduEngine.transcribe(Buffer.from(audioBuffer), this.baiduApiKey, this.baiduSecretKey),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('baidu asr timeout')), 20000)),
                    ]);
                    log('INFO', 'transcription', {
                        request_id: rid,
                        text,
                        audio_len_s: audioLen,
                        asr_inference_ms: Date.now() - t0,
                        engine: 'baidu',
                    });
                    return { text, request_id: rid };
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log('ERROR', 'asr_all_failed', { request_id: rid, error: msg });
                    return { text: '', request_id: rid, error: msg };
                }
            }
            return { text: '', request_id: rid, error: 'no ASR engine available' };
        }
        finally {
            decrement();
        }
    }
}
