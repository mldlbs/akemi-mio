#!/bin/bash
set -e
echo "=== Install dependencies ==="
cd /opt/telegram-bot
npm install --production
echo "=== nginx test ==="
/usr/local/nginx/sbin/nginx -t
echo "=== nginx reload ==="
/usr/local/nginx/sbin/nginx -s reload
echo "=== nginx done ==="
echo "=== env file ==="
cat > /opt/telegram-bot/.env << 'ENVEOF'
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN_HERE
# Multi-bot tokens (override TELEGRAM_BOT_TOKEN per bot)
# TOKEN_CHAT=xxx
# TOKEN_PUSH=xxx
# TOKEN_GEN=xxx
# TOKEN_WRITE=xxx
PUBLIC_URL=https://skills.crlkcloud.cyou/telegram
PORT=3003
# Proxy for Telegram API (required if GFW blocks api.telegram.org)
HTTP_PROXY=http://127.0.0.1:7890
# TG_API_TIMEOUT=15000
ENVEOF
echo "=== .env created ==="
echo "=== pm2 restart ==="
cd /opt/telegram-bot
pm2 delete telegram-bot 2>/dev/null || true
pm2 start index.js --name telegram-bot
pm2 save
echo "=== DONE ==="
