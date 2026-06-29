import { log } from '../logger/Logger';
import { join } from 'path';
export const EMBED_DIM = 384;
const MODEL_CACHE_DIR = join(__dirname, '..', '..', '..', '..', 'models', 'Xenova');
export function cosineSimilarity(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
/**
 * 基于字符 n-gram 哈希的 fallback 嵌入。
 * 不需要网络或预训练模型，确定性、跨会话一致。
 */
export function fallbackEmbed(text) {
    const vec = new Float64Array(EMBED_DIM);
    const chars = text.toLowerCase().replace(/\s+/g, ' ');
    for (let n = 1; n <= 3; n++) {
        for (let i = 0; i <= chars.length - n; i++) {
            const gram = chars.slice(i, i + n);
            let hash = 5381;
            for (let j = 0; j < gram.length; j++) {
                hash = (hash << 5) + hash + gram.charCodeAt(j);
            }
            const idx = Math.abs(hash) % EMBED_DIM;
            vec[idx] += 1.0 / n;
        }
    }
    let norm = 0;
    for (let i = 0; i < EMBED_DIM; i++)
        norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBED_DIM; i++)
        vec[i] /= norm;
    return Array.from(vec);
}
let embedFn = null;
let embedInitAttempted = false;
export async function getEmbedding(text) {
    if (!embedFn) {
        if (embedInitAttempted)
            return fallbackEmbed(text);
        embedInitAttempted = true;
        try {
            const { pipeline } = await import('@xenova/transformers');
            const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                cache_dir: MODEL_CACHE_DIR,
                local_files_only: true,
            });
            embedFn = async (t) => {
                const result = await extractor(t, { pooling: 'mean', normalize: true });
                return Array.from(result.data);
            };
        }
        catch {
            try {
                const { pipeline } = await import('@xenova/transformers');
                const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                    cache_dir: MODEL_CACHE_DIR,
                });
                embedFn = async (t) => {
                    const result = await extractor(t, { pooling: 'mean', normalize: true });
                    return Array.from(result.data);
                };
            }
            catch (err) {
                log('WARN', 'embedding_init_failed', { error: String(err) });
                log('INFO', 'embedding_fallback_activated', {});
                embedFn = async (t) => fallbackEmbed(t);
            }
        }
    }
    return embedFn(text);
}
