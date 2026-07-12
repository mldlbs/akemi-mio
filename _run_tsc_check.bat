@echo off
cd /d "D:\work\code\akemi-mio"
call node_modules\.bin\tsc.cmd --noEmit -p tsconfig.node.json
echo Exit code: %ERRORLEVEL%
