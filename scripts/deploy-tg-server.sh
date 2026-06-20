#!/bin/bash
set -e
echo "=== nginx test ==="
/usr/local/nginx/sbin/nginx -t
echo "=== nginx reload ==="
/usr/local/nginx/sbin/nginx -s reload
echo "=== nginx done ==="
echo "=== env file ==="
cat > /opt/telegram-bot/.env << 'ENVEOF'
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN_HERE
PUBLIC_URL=https://skills.crlkcloud.cyou/telegram
PORT=3003
ENVEOF
echo "=== .env created ==="
echo "=== pm2 start ==="
cd /opt/telegram-bot
pm2 delete telegram-bot 2>/dev/null || true
pm2 start index.js --name telegram-bot
pm2 save
echo "=== DONE ==="
