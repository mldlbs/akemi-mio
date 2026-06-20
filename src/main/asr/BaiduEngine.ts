import { withRetry, createTimeoutSignal } from '../utils/async'

export class BaiduEngine {
  private accessToken: string | null = null
  private tokenExpiry = 0
  private tokenPromise: Promise<string> | null = null

  async transcribe(pcmBuffer: Buffer, apiKey: string, secretKey: string, sampleRate = 16000): Promise<string> {
    return withRetry(async () => {
      const token = await this.getAccessToken(apiKey, secretKey)
      const { controller, timer } = createTimeoutSignal(10000)
      try {
        const res = await fetch(
          `https://vop.baidu.com/server_api?cuid=akemi-mio&token=${token}&dev_pid=1537`,
          {
            method: 'POST',
            headers: { 'Content-Type': `audio/pcm;rate=${sampleRate}` },
            body: pcmBuffer as BodyInit,
            signal: controller.signal
          }
        )
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`asr http ${res.status}: ${text}`)
        }
        const data = await res.json() as { err_no: number; err_msg?: string; result?: string[] }
        if (data.err_no !== 0) throw new Error(`baidu asr ${data.err_no}: ${data.err_msg || ''}`)
        return data.result?.[0] || ''
      } finally {
        clearTimeout(timer)
      }
    }, 2, 1000)
  }

  private async getAccessToken(apiKey: string, secretKey: string): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken
    if (this.tokenPromise) return this.tokenPromise

    this.tokenPromise = withRetry(async () => {
      const { controller, timer } = createTimeoutSignal(5000)
      try {
        const res = await fetch(
          `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`,
          { method: 'GET', signal: controller.signal }
        )
        if (!res.ok) throw new Error(`token http ${res.status}`)
        const data = await res.json() as { access_token?: string; expires_in?: number }
        if (!data.access_token) throw new Error('token response missing access_token')
        this.accessToken = data.access_token
        this.tokenExpiry = Date.now() + (data.expires_in || 2592000) * 1000
        return this.accessToken
      } finally {
        clearTimeout(timer)
      }
    }, 2, 1000)

    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }
}
