import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useState, useCallback, useEffect } from 'react';
import { updateMicEnergy, stopTTS } from './audioShared';
const RLOG = (level, event, meta) => {
    const beijing = new Date(Date.now() + 8 * 3600 * 1000);
    const ts = beijing.toISOString().replace('Z', '+08:00');
    console.log(JSON.stringify({ level, timestamp: ts, event, ...(meta || {}) }));
};
const SILENCE_MS = 6000;
const BUFFER_SIZE = 2048;
const ASR_SAMPLE_RATE = 16000;
const MIN_SPEAKING_FRAMES = 2;
const GRACE_FRAMES = 40;
const NOISE_FLOOR_FRAMES = 50;
const RMS_MULTIPLIER = 2.5;
const SPEECH_ZCR_MAX = 0.25;
const MAX_ASR_AUDIO_SECONDS = 25;
const INTERRUPTION_MIN_FRAMES = 18;
const INTERRUPTION_RMS_MULTIPLIER = 3.5;
const MIN_ASR_SAMPLES = 8000;
const DEFAULT_WAKE_WORDS = ['澪', '秋山澪', 'mio', 'Mio', '开始对话'];
const NOISE_COOLDOWN_THRESHOLD = 3;
const NOISE_COOLDOWN_MS = 8000;
/** TTS 结束时尾音保护期：期间采集的音频不会送 ASR，防止 TTS 回声被转录 */
const TAIL_MS = 4000;
/** echo_tail 完全结束后额外禁止 VAD 采集的时长（房间回声残留衰减期） */
const POST_TAIL_QUIET_MS = 4000;
/** echo_tail 中认定为"真实人声"的倍率（高于 TTS 打断阈值，防止回声误触 ASR） */
const TAIL_SPEECH_RMS_MULTIPLIER = 5.0;
function resample(audio, fromRate, toRate) {
    if (fromRate === toRate)
        return audio;
    const ratio = fromRate / toRate;
    const result = new Float32Array(Math.ceil(audio.length / ratio));
    for (let i = 0; i < result.length; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        result[i] = idx + 1 < audio.length ? audio[idx] * (1 - frac) + audio[idx + 1] * frac : audio[idx] || 0;
    }
    return result;
}
export function VoiceInput({ onResult, disabled, onConversationChange, ttsPlaying, onWakeWord }) {
    const [active, setActive] = useState(false);
    const [status, setStatus] = useState('');
    const modeRef = useRef('idle');
    const streamRef = useRef(null);
    const audioCtxRef = useRef(null);
    const processorRef = useRef(null);
    const samplesRef = useRef([]);
    const silenceTimerRef = useRef(null);
    const isSpeakingRef = useRef(false);
    const interruptSamplesRef = useRef([]);
    const wakeWordsRef = useRef(DEFAULT_WAKE_WORDS);
    /** TTS 期间采集的缓冲（可能含回声），TTS 结束后丢弃 */
    const ttsEchoBufferRef = useRef([]);
    /** 上次 TTS 结束时间戳，用于尾音保护 */
    const ttsEndTimeRef = useRef(0);
    /** echo_tail 完全退出后禁止 VAD 采集的时间戳（房间回声残留衰减期） */
    const postTailNoCaptureUntilRef = useRef(0);
    useEffect(() => {
        window.electronAPI
            .getWakeWords()
            .then((words) => {
            wakeWordsRef.current = words;
            RLOG('INFO', 'wake_words_loaded', { words });
        })
            .catch((err) => {
            RLOG('WARN', 'wake_words_load_failed', { error: String(err) });
        });
    }, []);
    const noiseCooldownRef = useRef(0);
    const consecutiveEmptyResultsRef = useRef(0);
    const setMode = useCallback((m) => {
        modeRef.current = m;
        RLOG('INFO', 'mode_change', { mode: m });
    }, []);
    const isMode = (m) => modeRef.current === m;
    const isWake = () => isMode('wake');
    const isListening = () => isMode('listening') || isMode('wake') || isMode('echo_tail');
    const closeAudio = useCallback(() => {
        if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        if (processorRef.current) {
            processorRef.current.onaudioprocess = null;
            processorRef.current.disconnect();
        }
        if (audioCtxRef.current) {
            audioCtxRef.current.close();
            audioCtxRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
        }
        processorRef.current = null;
    }, []);
    const processAudio = useCallback(async (samples, sampleRate) => {
        if (!samples.length)
            return;
        setMode('processing');
        let totalLen = 0;
        for (const s of samples)
            totalLen += s.length;
        const merged = new Float32Array(totalLen);
        let off = 0;
        for (const s of samples) {
            merged.set(s, off);
            off += s.length;
        }
        samples.length = 0;
        let resampled = sampleRate !== ASR_SAMPLE_RATE ? resample(merged, sampleRate, ASR_SAMPLE_RATE) : merged;
        const maxSamples = MAX_ASR_AUDIO_SECONDS * ASR_SAMPLE_RATE;
        if (resampled.length > maxSamples)
            resampled = resampled.slice(resampled.length - maxSamples);
        if (resampled.length < MIN_ASR_SAMPLES) {
            RLOG('WARN', 'asr_audio_too_short', { samples: resampled.length });
            if (isListening())
                setStatus('监听中...');
            modeRef.current = isWake() ? 'wake' : 'listening';
            return;
        }
        let peak = 0;
        for (let i = 0; i < resampled.length; i++) {
            const v = Math.abs(resampled[i]);
            if (v > peak)
                peak = v;
        }
        const gain = peak > 0.001 ? Math.min(0.6 / peak, 20) : 1;
        const pcm = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++)
            pcm[i] = Math.max(-32768, Math.min(32767, resampled[i] * gain * 32768));
        const audioBuf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
        setStatus('识别中...');
        let result;
        // TTS 尾音保护：结束后 1.5s 内不送 ASR
        if (Date.now() - ttsEndTimeRef.current < 1500) {
            RLOG('INFO', 'asr_skip_echo_tail', { sinceTtsEnd: Date.now() - ttsEndTimeRef.current });
            if (isListening())
                setStatus('监听中...');
            modeRef.current = isWake() ? 'wake' : 'listening';
            return;
        }
        try {
            result = await window.electronAPI.transcribe(audioBuf);
        }
        catch (err) {
            RLOG('ERROR', 'asr_transcribe_crash', { error: String(err) });
            setStatus('识别异常');
            setTimeout(() => {
                if (isListening())
                    setStatus('监听中...');
            }, 1500);
            modeRef.current = isWake() ? 'wake' : 'listening';
            return;
        }
        if (result.text && result.text.trim()) {
            consecutiveEmptyResultsRef.current = 0;
            noiseCooldownRef.current = 0;
            // 转录完成但用户已经关闭对话 → 丢弃结果
            if (modeRef.current === 'idle') {
                RLOG('INFO', 'asr_skip_conversation_closed', { text: result.text });
                return;
            }
            if (isWake()) {
                const wakeHit = wakeWordsRef.current.some((w) => result.text.includes(w));
                if (wakeHit) {
                    RLOG('INFO', 'wake_word_detected', { text: result.text });
                    setMode('listening');
                    setActive(true);
                    onConversationChange?.(true);
                    onWakeWord?.();
                    setStatus('监听中...');
                    samplesRef.current = [];
                    return;
                }
                modeRef.current = 'wake';
                return;
            }
            onResult(result.text, result.request_id);
            modeRef.current = 'listening';
        }
        else if (result.error) {
            setStatus(`识别失败: ${result.error}`);
            consecutiveEmptyResultsRef.current++;
            setTimeout(() => {
                if (isListening())
                    setStatus('监听中...');
            }, 1500);
            modeRef.current = isWake() ? 'wake' : 'listening';
        }
        else {
            consecutiveEmptyResultsRef.current++;
            if (consecutiveEmptyResultsRef.current >= NOISE_COOLDOWN_THRESHOLD) {
                noiseCooldownRef.current = Date.now() + NOISE_COOLDOWN_MS;
                consecutiveEmptyResultsRef.current = 0;
                RLOG('INFO', 'asr_noise_cooldown_activated', { cooldown_ms: NOISE_COOLDOWN_MS });
                setStatus(`背景音已忽略 ${NOISE_COOLDOWN_MS / 1000}s`);
                setTimeout(() => {
                    if (isListening())
                        setStatus('监听中...');
                }, 1500);
            }
            else {
                setStatus('没听清，请再说一遍');
                setTimeout(() => {
                    if (isListening())
                        setStatus('监听中...');
                }, 800);
            }
            modeRef.current = isWake() ? 'wake' : 'listening';
        }
    }, [onResult, onConversationChange, onWakeWord]);
    const setupAudio = useCallback(async () => {
        if (streamRef.current)
            return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            streamRef.current = stream;
            const audioCtx = new AudioContext();
            audioCtxRef.current = audioCtx;
            const sr = audioCtx.sampleRate;
            const source = audioCtx.createMediaStreamSource(stream);
            const highpass = audioCtx.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = 80;
            highpass.Q.value = 0.7;
            const lowpass = audioCtx.createBiquadFilter();
            lowpass.type = 'lowpass';
            lowpass.frequency.value = 7600;
            lowpass.Q.value = 0.7;
            const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
            processorRef.current = processor;
            samplesRef.current = [];
            isSpeakingRef.current = false;
            let speechFrames = 0;
            let graceFrames = 0;
            const noiseFloorHistory = [];
            let dynamicThreshold = 0.06;
            let lastVadEvent = 0;
            let interruptionFrames = 0;
            if (silenceTimerRef.current) {
                clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = null;
            }
            // 尾音保护定时器引用
            let tailTimer = null;
            RLOG('INFO', 'audio_capture_start', { sampleRate: sr });
            RLOG('INFO', 'vad_config', { silenceMs: SILENCE_MS });
            processor.onaudioprocess = (e) => {
                const mode = modeRef.current;
                if (mode === 'idle')
                    return;
                const input = e.inputBuffer.getChannelData(0);
                let sum = 0, zcr = 0;
                for (let i = 0; i < input.length; i++) {
                    sum += input[i] * input[i];
                    if (i > 0 && ((input[i - 1] >= 0 && input[i] < 0) || (input[i - 1] < 0 && input[i] >= 0)))
                        zcr++;
                }
                const rms = Math.sqrt(sum / input.length);
                const zcrRate = zcr / input.length;
                updateMicEnergy(rms);
                noiseFloorHistory.push(rms);
                if (noiseFloorHistory.length > NOISE_FLOOR_FRAMES)
                    noiseFloorHistory.shift();
                const sorted = [...noiseFloorHistory].sort((a, b) => a - b);
                const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] || 0.001;
                dynamicThreshold = Math.max(0.06, noiseFloor * RMS_MULTIPLIER);
                const aboveNoise = rms > dynamicThreshold && zcrRate < SPEECH_ZCR_MAX;
                const aboveInterruption = rms > dynamicThreshold * INTERRUPTION_RMS_MULTIPLIER && zcrRate < SPEECH_ZCR_MAX;
                /* ===== TTS 播放中: 全双工 VAD ===== */
                if (mode === 'playing_tts') {
                    if (aboveInterruption) {
                        interruptionFrames++;
                    }
                    else {
                        interruptionFrames = 0;
                    }
                    // 持续采集到 TTS 回声缓冲
                    ttsEchoBufferRef.current.push(new Float32Array(input));
                    if (interruptionFrames >= INTERRUPTION_MIN_FRAMES) {
                        RLOG('INFO', 'tts_interruption_detected', {
                            rms,
                            threshold: dynamicThreshold * INTERRUPTION_RMS_MULTIPLIER,
                            frames: interruptionFrames,
                        });
                        window.electronAPI.stopSpeaking();
                        stopTTS();
                        // 打断后：丢弃 TTS 回声缓冲和打断样本（这些是 AI 自己的回声）
                        // 同时进入 echo_tail 保护期，防止残余回声被循环送 ASR
                        ttsEchoBufferRef.current = [];
                        interruptSamplesRef.current = [];
                        samplesRef.current = [];
                        interruptionFrames = 0;
                        isSpeakingRef.current = false;
                        ttsEndTimeRef.current = Date.now();
                        setMode('echo_tail');
                        setStatus('尾音保护...');
                    }
                    return;
                }
                /* ===== TTS 尾音保护期: 采集但不上报 ASR ===== */
                if (mode === 'echo_tail') {
                    // 仍然采集（用于尾音结束后做 VAD 平滑过渡）
                    ttsEchoBufferRef.current.push(new Float32Array(input));
                    // 使用极高阈值判断真实人声，防止残余 TTS 回声触发 ASR
                    const aboveRealVoice = rms > dynamicThreshold * TAIL_SPEECH_RMS_MULTIPLIER && zcrRate < SPEECH_ZCR_MAX;
                    if (aboveRealVoice) {
                        speechFrames = Math.min(speechFrames + 1, MIN_SPEAKING_FRAMES + 1);
                    }
                    else {
                        speechFrames = 0;
                    }
                    if (speechFrames >= MIN_SPEAKING_FRAMES) {
                        // 尾音期听到了真实说话 → 立即退出尾音保护
                        // 不把混合回声的缓冲送 ASR，让正常 VAD 捕获纯净语音
                        if (tailTimer) {
                            clearTimeout(tailTimer);
                            tailTimer = null;
                        }
                        ttsEchoBufferRef.current = [];
                        samplesRef.current = [];
                        isSpeakingRef.current = false;
                        setMode('listening');
                        setStatus('说话中...');
                    }
                    return;
                }
                /* ===== 正常 VAD (listening / wake) ===== */
                interruptionFrames = 0;
                // echo_tail 结束后的静默期内禁止采集样本（房间回声残留衰减期）
                if (Date.now() < postTailNoCaptureUntilRef.current) {
                    // 仍然更新噪声底噪，但不采样
                    if (aboveNoise)
                        graceFrames = GRACE_FRAMES;
                    isSpeakingRef.current = false;
                    return;
                }
                if (aboveNoise) {
                    speechFrames = Math.min(speechFrames + 1, MIN_SPEAKING_FRAMES + 1);
                }
                else {
                    speechFrames = 0;
                }
                const speaking = speechFrames >= MIN_SPEAKING_FRAMES;
                const buf = interruptSamplesRef.current.length > 0 ? interruptSamplesRef.current : samplesRef.current;
                if (aboveNoise || isSpeakingRef.current || speaking || graceFrames > 0) {
                    buf.push(new Float32Array(input));
                    if (aboveNoise)
                        graceFrames = GRACE_FRAMES;
                    else if (graceFrames > 0)
                        graceFrames--;
                }
                if (aboveNoise && !isSpeakingRef.current && Date.now() - lastVadEvent > 5000) {
                    lastVadEvent = Date.now();
                    RLOG('PERF', 'vad_speech_detected', { rms, zcr: zcrRate, threshold: dynamicThreshold });
                }
                if (isSpeakingRef.current && !speaking && Date.now() - lastVadEvent > 1000) {
                    lastVadEvent = Date.now();
                    RLOG('PERF', 'vad_speech_ended', { noiseFloor });
                }
                if (speaking) {
                    if (silenceTimerRef.current) {
                        clearTimeout(silenceTimerRef.current);
                        silenceTimerRef.current = null;
                    }
                    setStatus('说话中...');
                }
                else if (isSpeakingRef.current && !silenceTimerRef.current && mode === 'listening') {
                    if (Date.now() < noiseCooldownRef.current) {
                        RLOG('INFO', 'asr_skip_noise_cooldown', { until: noiseCooldownRef.current });
                        buf.splice(0);
                        isSpeakingRef.current = false;
                        samplesRef.current = [];
                        setStatus('监听中...');
                        return;
                    }
                    const captured = buf;
                    silenceTimerRef.current = setTimeout(() => {
                        silenceTimerRef.current = null;
                        if (modeRef.current !== 'listening' && modeRef.current !== 'wake')
                            return;
                        setStatus('识别中...');
                        processAudio(captured.splice(0), sr);
                    }, SILENCE_MS);
                    setStatus('等待结尾...');
                }
                isSpeakingRef.current = speaking;
            };
            source.connect(highpass);
            highpass.connect(lowpass);
            lowpass.connect(processor);
            processor.connect(audioCtx.destination);
        }
        catch (err) {
            console.error('启动录音失败:', err);
            setStatus('麦克风不可用');
        }
    }, [processAudio]);
    // TTS 状态变化：全双工模式
    useEffect(() => {
        if (ttsPlaying && isListening()) {
            setMode('playing_tts');
            ttsEchoBufferRef.current = [];
            if (silenceTimerRef.current) {
                clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = null;
            }
            setStatus('回复中...');
            return;
        }
        if (!ttsPlaying && modeRef.current === 'playing_tts') {
            RLOG('INFO', 'vad_enter_echo_tail', { tailMs: TAIL_MS });
            // TTS 结束 → 不关麦克风，切到 echo_tail 保护期
            setMode('echo_tail');
            ttsEndTimeRef.current = Date.now();
            setStatus('尾音保护...');
            // TAIL_MS 后丢弃回声缓冲，恢复 listening
            // 同时设静默期阻止 VAD 采集残余房间回声（见 @bug:self-dialog-loop）
            const t = setTimeout(() => {
                if (modeRef.current === 'echo_tail') {
                    RLOG('INFO', 'vad_tts_tail_ended', { discarded: ttsEchoBufferRef.current.length });
                    ttsEchoBufferRef.current = [];
                    postTailNoCaptureUntilRef.current = Date.now() + POST_TAIL_QUIET_MS;
                    modeRef.current = isWake() ? 'wake' : 'listening';
                    setStatus('监听中...');
                }
            }, TAIL_MS);
            // 在 effect 卸载时清理
            return () => clearTimeout(t);
        }
    }, [ttsPlaying, setMode]);
    useEffect(() => {
        return () => {
            closeAudio();
            modeRef.current = 'idle';
        };
    }, [closeAudio]);
    const toggleConversation = useCallback(() => {
        if (active) {
            window.electronAPI.stopConversation().catch(() => { });
            window.electronAPI.stopSpeaking().catch(() => { });
            closeAudio();
            modeRef.current = 'idle';
            samplesRef.current = [];
            interruptSamplesRef.current = [];
            ttsEchoBufferRef.current = [];
            isSpeakingRef.current = false;
            setActive(false);
            setStatus('');
            onConversationChange?.(false);
            RLOG('INFO', 'conversation_stopped');
        }
        else {
            setMode('listening');
            setActive(true);
            onConversationChange?.(true);
            setStatus('监听中...');
            if (!streamRef.current) {
                setupAudio().catch((err) => {
                    RLOG('ERROR', 'mic_setup_failed', { error: String(err) });
                    setStatus('麦克风启动失败');
                    setActive(false);
                    setMode('idle');
                    onConversationChange?.(false);
                });
            }
        }
    }, [active, closeAudio, setupAudio, onConversationChange]);
    return (_jsxs("div", { className: "voice-input", children: [_jsx("button", { className: `btn-voice ${active ? 'active' : ''}`, onClick: toggleConversation, disabled: disabled, children: _jsx("i", { className: `${active ? 'ri-stop-fill' : 'ri-mic-fill'}` }) }), _jsx("button", { className: "btn-icon btn-danger", onClick: () => {
                    window.electronAPI?.stopSpeaking?.();
                    stopTTS();
                }, disabled: !ttsPlaying, children: _jsx("i", { className: "ri-stop-circle-line" }) })] }));
}
