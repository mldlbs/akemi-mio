import { TtsStateCallback } from './types';
export declare function cleanTTS(text: string): string;
export declare class TtsService {
    private onStateUpdate;
    private onAudioReady;
    private currentProcess;
    private playbackStopRequested;
    private ttsQueue;
    private isProcessing;
    private sentenceBuf;
    private batchTimer;
    private stopped;
    constructor(onStateUpdate: TtsStateCallback, onAudioReady?: (filePath: string) => void);
    setAudioSink(cb: (filePath: string) => void): void;
    addChunk(chunk: string): void;
    flushBuffer(): void;
    stop(): void;
    speak(text: string): Promise<void>;
    private speakInternal;
    private _synthesize;
    private _playAudio;
    private _logError;
    private processQueue;
}
