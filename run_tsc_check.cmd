@echo off
cd /d D:\work\code\akemi-mio
npx tsc --noEmit -p tsconfig.node.json
echo Exit code: %ERRORLEVEL%
