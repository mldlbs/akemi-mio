const https = require('https')
const BOT_TOKEN = '8687338168:AAFAEv5e0HWU95egICwGt0Diq_47utp1FCo'

function tgApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    const url = new URL('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method + qs)
    https.get(url, (res) => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

tgApi('getMe').then(d => console.log(JSON.stringify(d))).catch(e => console.log('ERR', e.message))
