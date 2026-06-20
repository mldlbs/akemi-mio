const https = require('https')
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8687338168:AAFAEv5e0HWU95egICwGt0Diq_47utp1FCo'

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.telegram.org/bot' + TOKEN + path, { timeout: 10000 }, (res) => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', (e) => reject(e))
    req.end()
  })
}

get('/getMe').then(r => {
  console.log('OK:', r.ok, JSON.stringify(r.result?.first_name || r))
}).catch(e => {
  console.log('ERR:', e.code, e.message)
  console.log('sys err:', Object.keys(e).join(','))
})
