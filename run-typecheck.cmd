@echo off
cd /d "D:\work\code\akemi-mio"
npx tsc --noEmit -p tsconfig.node.json > tsc-result.txt 2>&1
type tsc-result.txt
