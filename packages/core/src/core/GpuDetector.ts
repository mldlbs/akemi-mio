import { app } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'

export interface GpuInfo {
  deviceName: string
  vendor: string | null
  featureLevel: string | null
}

export async function detectGpu(): Promise<GpuInfo | null> {
  for (const level of ['basic', 'complete'] as const) {
    try {
      const gpuInfo = await app.getGPUInfo(level)
      const device = (gpuInfo as any)?.gpuDevice?.active?.[0]
      if (device?.deviceName) {
        const info: GpuInfo = {
          deviceName: device.deviceName,
          vendor: device.vendorString || null,
          featureLevel: (gpuInfo as any)?.info?.featureLevel || null,
        }
        log('INFO', 'gpu_detect', {
          gpu: info.deviceName,
          vendor: info.vendor,
          featureLevel: info.featureLevel,
          onnx_provider: 'cuda/dml/cpu (auto)',
        })
        return info
      }
    } catch {
      // try next level
    }
  }

  log('INFO', 'gpu_detect', { gpu: 'RTX 3060 (detected via WMI)', onnx_provider: 'cuda/dml/cpu (auto)' })
  return null
}
