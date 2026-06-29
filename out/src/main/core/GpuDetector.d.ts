export interface GpuInfo {
    deviceName: string;
    vendor: string | null;
    featureLevel: string | null;
}
export declare function detectGpu(): Promise<GpuInfo | null>;
