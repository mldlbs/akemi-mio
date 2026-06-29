export declare function updateMicEnergy(rms: number): void;
export declare function readMicEnergy(): number;
export declare function onTTSStart(cb: (duration: number) => void): void;
export declare function onTTSError(cb: (err: string) => void): void;
export declare function playTTS(filePath: string): void;
export declare function playTTSBuffer(buf: ArrayBuffer): void;
export declare function stopTTS(): void;
export declare function readTTSEnergy(): number;
