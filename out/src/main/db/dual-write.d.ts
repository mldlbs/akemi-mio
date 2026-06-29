export interface DualWriteConfig {
    label: string;
    writeDb: () => void;
    writeJson: () => void;
    countDb: () => number;
    countJson: () => number;
}
export declare class DualWriteHelper {
    private jsonEnabled;
    disableJson(): void;
    write(config: DualWriteConfig): void;
    verify(config: DualWriteConfig): boolean;
}
export declare const dualWrite: DualWriteHelper;
