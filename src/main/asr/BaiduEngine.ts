export class BaiduEngine {
  private accessToken: string | null = null
  private tokenExpiry = 0
  private tokenPromise: Promise<string> | null = null

  async transcribe(pcmBuffer: Buffer, apiKey: string, secretKey: string, sampleRate = 16000): Promise<string> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const token = await this.getAccessToken(apiKey, secretKey)
        const res = await fetchWithTimeout(
          `https://vop.baidu.com/server_api?cuid=akemi-mio&token=${token}&dev_pid=1537`,
          {
            method: 'POST',
            headers: { 'Content-Type': `audio/pcm;rate=${sampleRate}` },
            body: pcmBuffer,
            timeout: 10000
          }
        )

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`asr http ${res.status}: ${text}`)
        }
        const data = await res.json() as { err_no: number; err_msg?: string; result?: string[] }
        if (data.err_no !== 0) throw new Error(`baidu asr ${data.err_no}: ${data.err_msg || ''}`)
        return data.result?.[0] || ''
      } catch (err) {
        if (attempt === 2) throw err
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    throw new Error('unreachable')
  }

  private async getAccessToken(apiKey: string, secretKey: string): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken
    if (this.tokenPromise) return this.tokenPromise

    this.tokenPromise = (async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetchWithTimeout(
            `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`,
            { method: 'GET', timeout: 5000 }
          )
          if (!res.ok) throw new Error(`token http ${res.status}`)
          const data = await res.json() as { access_token?: string; expires_in?: number }
          if (!data.access_token) throw new Error('token response missing access_token')
          this.accessToken = data.access_token
          this.tokenExpiry = Date.now() + (data.expires_in || 2592000) * 1000
          return this.accessToken
        } catch (err) {
          if (attempt === 2) throw err
          await new Promise(r => setTimeout(r, 1000))
        }
      }
      throw new Error('unreachable')
    })()

    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }
}

function fetchWithTimeout(url: string, options: RequestInit & { timeout: number }): Promise<Response> {
  const { timeout, ...fetchOptions } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  return fetch(url, { ...fetchOptions, signal: controller.signal }).finally(() => clearTimeout(timer))
}
