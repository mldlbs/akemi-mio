import { app } from 'electron';
import { join } from 'path';
import { existsSync, statSync, readFileSync } from 'fs';
import { env as transformersEnv } from '@xenova/transformers';
import { log } from '../logger/Logger';
/** userData 优先，回退安装目录 */
function resolveFirst(...paths) {
    return existsSync(paths[0]) ? paths[0] : paths[1];
}
export function loadEnvFile() {
    try {
        const envPath = resolveFirst(join(app.getPath('userData'), '.env'), join(app.getAppPath(), '.env'));
        if (existsSync(envPath)) {
            for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
                const eq = line.indexOf('=');
                if (eq > 0)
                    process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
            }
        }
    }
    catch {
        /* .env optional */
    }
}
export function setupTransformers() {
    transformersEnv.useFSCache = true;
    const modelsDir = resolveFirst(join(app.getPath('userData'), 'models'), join(app.getAppPath(), 'models'));
    transformersEnv.localModelPath = modelsDir;
    transformersEnv.allowRemoteModels = true;
    try {
        const onnxBackend = require('@xenova/transformers/src/backends/onnx.js');
        if (onnxBackend.executionProviders) {
            onnxBackend.executionProviders.unshift('dml');
            log('INFO', 'gpu_enable', { provider: 'dml', providers: onnxBackend.executionProviders });
        }
    }
    catch (err) {
        log('WARN', 'gpu_config_failed', { error: String(err) });
    }
}
export function initASRWithCache(whisperEngine, stateManager, asrService) {
    if (asrService.useBaidu) {
        stateManager.update({ asr: 'ready' });
        return;
    }
    const modelsDir = resolveFirst(join(app.getPath('userData'), 'models'), join(app.getAppPath(), 'models'));
    const modelCachePath = join(modelsDir, 'Xenova', 'whisper-small', 'onnx', 'encoder_model_quantized.onnx');
    log('INFO', 'model_cache', { exists: existsSync(modelCachePath), path: modelCachePath });
    const modelFiles = [
        ['encoder_model_quantized.onnx', 92324809],
        ['decoder_model_merged_quantized.onnx', 156780950],
    ];
    for (const [file, expectedSize] of modelFiles) {
        const p = join(modelsDir, 'Xenova', 'whisper-small', 'onnx', file);
        if (existsSync(p)) {
            const actualSize = statSync(p).size;
            if (Math.abs(actualSize - expectedSize) > 1024) {
                log('WARN', 'model_file_size_mismatch', { file, expectedSize, actualSize });
            }
        }
    }
    try {
        whisperEngine
            .initialize('small')
            .then(() => {
            log('INFO', 'asr_ready');
            stateManager.update({ asr: 'ready' });
        })
            .catch((err) => {
            log('ERROR', 'asr_init_failed', { error: String(err) });
            stateManager.update({ error: 'Whisper 加载失败' });
        });
    }
    catch (err) {
        log('ERROR', 'asr_init_crash', { error: String(err) });
        stateManager.update({ error: 'Whisper 初始化异常' });
    }
}
