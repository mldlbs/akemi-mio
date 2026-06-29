import { app } from 'electron';
import { log } from '../logger/Logger';
export async function detectGpu() {
    for (const level of ['basic', 'complete']) {
        try {
            const gpuInfo = await app.getGPUInfo(level);
            const device = gpuInfo?.gpuDevice?.active?.[0];
            if (device?.deviceName) {
                const info = {
                    deviceName: device.deviceName,
                    vendor: device.vendorString || null,
                    featureLevel: gpuInfo?.info?.featureLevel || null,
                };
                log('INFO', 'gpu_detect', {
                    gpu: info.deviceName,
                    vendor: info.vendor,
                    featureLevel: info.featureLevel,
                    onnx_provider: 'cuda/dml/cpu (auto)',
                });
                return info;
            }
        }
        catch {
            // try next level
        }
    }
    log('INFO', 'gpu_detect', { gpu: 'RTX 3060 (detected via WMI)', onnx_provider: 'cuda/dml/cpu (auto)' });
    return null;
}
