import whisper from '@kutalia/whisper-node-addon';
import { join } from 'path';
import { promises as fsp, existsSync } from 'fs';
import { tmpdir } from 'os';
import { log } from '../logger/Logger';
import { Converter } from 'opencc-js';
import { GGML_MODELS_DIR, ASR_HOTWORDS, ASR_INITIAL_PROMPT } from '../config';
import { withTimeout } from '../utils/async';
import { applyHotwords } from './WhisperEngine';
// 简繁转换
const t2s = Converter({ from: 'tw', to: 'cn' });
// Whisper 同音字后处理修正（已知常见错误模式）
const HOMOPHONE_FIXES = [
    [/客服(?=就|已经|很|了|的)/g, '考试'], // 客服→考试
    [/铺子(?=确实|有|的|是)/g, '谱子'], // 铺子→谱子
    [/洛伦兹利/g, '洛伦兹力'],
    [/安培利/g, '安培力'],
    [/(\S)借\b/g, '$1劲'], // 借→劲 (这借→这劲)
];
// 生成 16kHz 单声道 WAV 文件头
function encodeWAV(samples) {
    const buf = Buffer.alloc(44 + samples.length * 2);
    const w = (i, v) => {
        buf.writeUInt16LE(v, i);
    };
    const dw = (i, v) => {
        buf.writeUInt32LE(v, i);
    };
    buf.write('RIFF', 0);
    dw(4, 36 + samples.length * 2);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    dw(16, 16); // chunk size
    w(20, 1); // PCM
    w(22, 1); // mono
    dw(24, 16000); // sample rate
    dw(28, 16000 * 2); // byte rate
    w(32, 2); // block align
    w(34, 16); // bits per sample
    buf.write('data', 36);
    dw(40, samples.length * 2);
    for (let i = 0; i < samples.length; i++)
        buf.writeInt16LE(samples[i], 44 + i * 2);
    return buf;
}
export class WhisperGpuEngine {
    constructor() {
        this.modelPath = null;
        this.loaded = false;
    }
    async initialize(model = 'small') {
        if (this.loaded)
            return;
        this.modelPath = join(GGML_MODELS_DIR, `ggml-${model}.bin`);
        log('INFO', 'gpu_asr_init_start', { model: `ggml-${model}.bin`, path: this.modelPath });
        const t0 = Date.now();
        if (!existsSync(this.modelPath)) {
            throw new Error(`Model not found: ${this.modelPath}`);
        }
        this.loaded = true;
        log('INFO', 'gpu_asr_init_complete', { model: `ggml-${model}`, duration_ms: Date.now() - t0, gpu: true });
    }
    async transcribe(pcmf32, timeoutMs = 15000) {
        if (!this.modelPath || !this.loaded)
            throw new Error('GPU ASR not initialized');
        const t0 = Date.now();
        const audioLen = (pcmf32.length / 16000).toFixed(1);
        // Float32 → Int16 → 临时 WAV 文件
        const int16 = new Int16Array(pcmf32.length);
        for (let i = 0; i < pcmf32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(pcmf32[i] * 32768)));
        }
        const wavBuf = encodeWAV(int16);
        const tmpFile = join(tmpdir(), `akemi-mio-${Date.now()}.wav`);
        await fsp.writeFile(tmpFile, wavBuf);
        log('INFO', 'gpu_asr_audio', { length_s: Number(audioLen), engine: 'whisper_gpu' });
        try {
            // 构建 initial_prompt：将热词以逗号列出，引导模型关注这些领域词汇
            const hotwordPrefix = `关键词: ${ASR_HOTWORDS.slice(0, 20).join(', ')}。`;
            const whisperPrompt = `${ASR_INITIAL_PROMPT} ${hotwordPrefix}`;
            log('INFO', 'gpu_initial_prompt', { prompt: whisperPrompt });
            const result = await withTimeout(() => whisper.transcribe({
                model: this.modelPath,
                fname_inp: tmpFile,
                language: 'zh',
                translate: false,
                use_gpu: true,
                flash_attn: false,
                no_prints: true,
                no_timestamps: true,
                initial_prompt: whisperPrompt,
            }), timeoutMs);
            const elapsed = Date.now() - t0;
            const rawTranscription = result?.transcription || [];
            // @kutalia/whisper-node-addon 返回两种格式：
            // no_timestamps=false → string[][]: [[start,end,text], ...]
            // no_timestamps=true  → string[]:   [text, ...]
            let text;
            if (rawTranscription.length > 0 && Array.isArray(rawTranscription[0])) {
                text = rawTranscription
                    .map((s) => s[2])
                    .join(' ')
                    .trim();
            }
            else {
                text = rawTranscription.join(' ').trim();
            }
            // 繁体→简体
            text = t2s(text);
            // 同音字后处理纠正
            let corrected = text;
            for (const [pattern, replacement] of HOMOPHONE_FIXES) {
                corrected = corrected.replace(pattern, replacement);
            }
            if (corrected !== text) {
                log('INFO', 'asr_corrected', { before: text, after: corrected });
                text = corrected;
            }
            const hotwordResult = applyHotwords(text);
            if (hotwordResult.hits.length > 0) {
                log('INFO', 'gpu_hotword_hits', { hits: hotwordResult.hits });
            }
            log('INFO', 'transcription', {
                text: hotwordResult.text,
                audio_len_s: Number(audioLen),
                asr_inference_ms: elapsed,
                engine: 'whisper_gpu',
                gpu: true,
            });
            return { text: hotwordResult.text, duration: elapsed, raw: hotwordResult.text !== text ? text : undefined, hits: hotwordResult.hits };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log('ERROR', 'gpu_asr_failed', { error: msg });
            throw err;
        }
        finally {
            try {
                await fsp.unlink(tmpFile);
            }
            catch { }
        }
    }
    getStatus() {
        return { loaded: this.loaded, loading: false, error: null };
    }
    getModelInfo() {
        return this.modelPath ? `ggml-small (GPU, Vulkan)` : 'not loaded';
    }
}
