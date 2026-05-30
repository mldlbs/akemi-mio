let accessToken: string | null = null
let tokenExpiry = 0

async function getAccessToken(apiKey: string, secretKey: string): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry) return accessToken

  const res = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`,
    { signal: AbortSignal.timeout(5000) }
  )
  if (!res.ok) throw new Error(`token http ${res.status}`)
  const data = await res.json() as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('token response missing access_token')
  accessToken = data.access_token
  tokenExpiry = Date.now() + (data.expires_in || 2592000) * 1000
  return accessToken
}

export async function baiduASR(pcmBuffer: Buffer, apiKey: string, secretKey: string, sampleRate = 16000): Promise<string> {
  const token = await getAccessToken(apiKey, secretKey)
  const body = pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength) as ArrayBuffer

  const res = await fetch(`https://vop.baidu.com/server_api?cuid=akemi-mio&token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': `audio/pcm;rate=${sampleRate}` },
    body,
    signal: AbortSignal.timeout(10000)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`asr http ${res.status}: ${text}`)
  }
  const data = await res.json() as { err_no: number; err_msg?: string; result?: string[] }
  if (data.err_no !== 0) throw new Error(`baidu asr ${data.err_no}: ${data.err_msg || ''}`)
  return data.result?.[0] || ''
}
