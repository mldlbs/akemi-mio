const { execSync } = require('child_process')
const r = execSync('/usr/bin/curl -s --connect-timeout 8 "https://api.telegram.org/bot8687338168:AAFAEv5e0HWU95egICwGt0Diq_47utp1FCo/getMe"', { timeout: 15000, encoding: 'utf-8' })
const d = JSON.parse(r)
console.log('OK', d.ok, d.result.first_name)
