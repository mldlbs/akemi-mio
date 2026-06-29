export declare class BaiduEngine {
    private accessToken;
    private tokenExpiry;
    private tokenPromise;
    transcribe(pcmBuffer: Buffer, apiKey: string, secretKey: string, sampleRate?: number): Promise<string>;
    private getAccessToken;
}
