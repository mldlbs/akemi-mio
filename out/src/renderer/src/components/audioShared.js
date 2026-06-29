let micEnergy = 0;
export function updateMicEnergy(rms) { micEnergy = Math.min(1, rms * 8); }
export function readMicEnergy() { return micEnergy; }
let ttsState = 'idle';
let ttsCtx = null;
let ttsSource = null;
let ttsAnalyser = null;
let ttsEnergy = 0;
let ttsAnimId = 0;
let ttsStartCb = null;
let ttsErrorCb = null;
export function onTTSStart(cb) { ttsStartCb = cb; }
export function onTTSError(cb) { ttsErrorCb = cb; }
function safeCleanup() {
    if (ttsAnimId) {
        cancelAnimationFrame(ttsAnimId);
        ttsAnimId = 0;
    }
    ttsEnergy = 0;
    try {
        if (ttsSource) {
            ttsSource.stop();
            ttsSource.disconnect();
        }
    }
    catch { /* already stopped */ }
    ttsSource = null;
    ttsAnalyser = null;
    if (ttsCtx && ttsCtx.state !== 'closed')
        ttsCtx.close();
    ttsCtx = null;
    ttsState = 'idle';
}
function doPlay(buf) {
    safeCleanup();
    ttsState = 'loading';
    const ctx = new AudioContext();
    ttsCtx = ctx;
    ctx.decodeAudioData(buf.slice(0))
        .then(audioBuf => {
        if (ttsState !== 'loading') {
            ctx.close();
            return;
        }
        ttsState = 'playing';
        const duration = audioBuf.duration;
        ttsStartCb?.(duration);
        ttsAnalyser = ctx.createAnalyser();
        ttsAnalyser.fftSize = 256;
        ttsAnalyser.smoothingTimeConstant = 0.85;
        ttsSource = ctx.createBufferSource();
        ttsSource.buffer = audioBuf;
        ttsSource.connect(ttsAnalyser);
        ttsAnalyser.connect(ctx.destination);
        ttsSource.start();
        const freqData = new Uint8Array(ttsAnalyser.frequencyBinCount);
        const poll = () => {
            if (ttsState !== 'playing')
                return;
            ttsAnalyser?.getByteFrequencyData(freqData);
            let total = 0;
            for (let b = 0; b < freqData.length; b++)
                total += freqData[b];
            ttsEnergy = total / (freqData.length * 255);
            ttsAnimId = requestAnimationFrame(poll);
        };
        poll();
        ttsSource.onended = () => { safeCleanup(); };
    })
        .catch(err => {
        if (ttsCtx === ctx)
            safeCleanup();
        ttsErrorCb?.(String(err));
    });
}
export function playTTS(filePath) {
    try {
        fetch(`file://${filePath.replace(/\\/g, '/')}`)
            .then(r => { if (!r.ok)
            throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
            .then(buf => doPlay(buf))
            .catch((err) => {
            console.error('[TTS] playTTS fetch failed:', err);
            ttsErrorCb?.(`TTS 文件加载失败: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    catch (err) {
        console.error('[TTS] playTTS failed:', err);
        ttsErrorCb?.(`TTS 播放异常: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function playTTSBuffer(buf) {
    doPlay(buf);
}
export function stopTTS() {
    safeCleanup();
}
export function readTTSEnergy() {
    return ttsEnergy;
}
