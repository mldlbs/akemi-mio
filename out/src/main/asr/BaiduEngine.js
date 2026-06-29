import { withRetry, createTimeoutSignal } from '../utils/async';
export class BaiduEngine {
    constructor() {
        this.accessToken = null;
        this.tokenExpiry = 0;
        this.tokenPromise = null;
    }
    async transcribe(pcmBuffer, apiKey, secretKey, sampleRate = 16000) {
        return withRetry(async () => {
            const token = await this.getAccessToken(apiKey, secretKey);
            const { controller, timer } = createTimeoutSignal(10000);
            try {
                const res = await fetch(`https://vop.baidu.com/server_api?cuid=akemi-mio&token=${token}&dev_pid=1537`, {
                    method: 'POST',
                    headers: { 'Content-Type': `audio/pcm;rate=${sampleRate}` },
                    body: pcmBuffer,
                    signal: controller.signal
                });
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    throw new Error(`asr http ${res.status}: ${text}`);
                }
                const data = await res.json();
                if (data.err_no !== 0)
                    throw new Error(`baidu asr ${data.err_no}: ${data.err_msg || ''}`);
                return data.result?.[0] || '';
            }
            finally {
                clearTimeout(timer);
            }
        }, 2, 1000);
    }
    async getAccessToken(apiKey, secretKey) {
        if (this.accessToken && Date.now() < this.tokenExpiry)
            return this.accessToken;
        if (this.tokenPromise)
            return this.tokenPromise;
        this.tokenPromise = withRetry(async () => {
            const { controller, timer } = createTimeoutSignal(5000);
            try {
                const res = await fetch(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`, { method: 'GET', signal: controller.signal });
                if (!res.ok)
                    throw new Error(`token http ${res.status}`);
                const data = await res.json();
                if (!data.access_token)
                    throw new Error('token response missing access_token');
                this.accessToken = data.access_token;
                this.tokenExpiry = Date.now() + (data.expires_in || 2592000) * 1000;
                return this.accessToken;
            }
            finally {
                clearTimeout(timer);
            }
        }, 2, 1000);
        try {
            return await this.tokenPromise;
        }
        finally {
            this.tokenPromise = null;
        }
    }
}
