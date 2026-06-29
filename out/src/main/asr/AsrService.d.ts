import { WhisperGpuEngine } from './WhisperGpuEngine';
import { BaiduEngine } from './BaiduEngine';
export declare class AsrService {
    private gpuEngine;
    private cpuEngine;
    private cpuInitPromise;
    private baiduEngine;
    private baiduApiKey?;
    private baiduSecretKey?;
    private _pendingRequests;
    constructor(gpuEngine: WhisperGpuEngine, baiduEngine: BaiduEngine);
    private isCorrupted;
    private initCpuFallback;
    setBaiduCredentials(apiKey: string, secretKey: string): void;
    get useBaidu(): boolean;
    get pendingRequests(): number;
    transcribe(audioBuffer: ArrayBuffer, requestId?: string): Promise<{
        text: string;
        request_id: string;
        error?: string;
    }>;
}
