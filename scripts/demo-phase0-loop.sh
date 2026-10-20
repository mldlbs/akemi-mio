#!/usr/bin/env bash
# Reproducible Phase 0 verification-loop demo for ADR-017 (TaskHub 9ac4a8f8).
#
# "安装一次，所有 Agent 自动接入" 的可复现演示：
#   mio init -> (mio install <host> x2) -> 跨 Agent 经验复用 -> 评估检查表 4 指标可采集
#
# 说明：
#   - 本脚本把 MIO_HOME 指向一个临时目录，写入最小跨 Agent 数据集，然后跑只读的
#     检视命令，证明整条闭环可用。
#   - `mio install <host>` 会改写宿主（codex/opencode/...）的真实配置文件，默认跳过；
#     真实录屏演示时设 RUN_INSTALL=1 由演示者手动执行（或在两台宿主上分别执行）。
#   - route_events.jsonl 在生产中由 MCP 侧的 mio.task.route 调用落盘；这里直接 seed
#     以演示「路由采纳率」指标可被采集。
set -euo pipefail

MIA_REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node \"$MIA_REPO/packages/mio-cli/bin/mio.js\""

export MIO_HOME="${MIO_HOME:-$(mktemp -d -t mio-demo-XXXX)}"
echo "MIO_HOME=$MIO_HOME"

echo "== 1. mio init =="
eval "$CLI" init

# 真实安装会改写宿主配置，默认跳过（录屏演示时 RUN_INSTALL=1）。
if [ "${RUN_INSTALL:-0}" = "1" ]; then
  echo "== 1b. mio install <host> x2 (mutates host configs) =="
  eval "$CLI" install codex
  eval "$CLI" install opencode
fi

echo "== 2. seed 最小跨 Agent 数据集 =="
cat > "$MIO_HOME/memory.jsonl" <<'JSON'
{"id":"m1","timestamp":"2026-10-20T00:00:00.000Z","kind":"fix","content":"deploy service behind a blue-green switch to avoid downtime","tags":["deploy","blue-green"],"project":"acme","scope":"project"}
JSON

cat > "$MIO_HOME/experience_reuse.jsonl" <<'JSON'
{"id":"x1","experienceId":"m1","sourceAgent":"codex","targetAgent":"opencode","reuse":true,"behaviorChanged":true,"outcomeImproved":true,"confirmed":true,"confirmedBy":"agent","project":"acme","source":"auto_claim","traceId":"t1"}
JSON

cat > "$MIO_HOME/traces.jsonl" <<'JSON'
{"id":"tr1","trace_id":"t1","event_type":"task_outcome","outcome":"success","agent":"codex","project":"acme","timestamp":"2026-10-20T00:01:00.000Z"}
{"id":"tr2","trace_id":"t2","event_type":"task_outcome","outcome":"success","agent":"opencode","project":"acme","timestamp":"2026-10-20T00:02:00.000Z"}
JSON

# 路由采纳证据：生产中由 MCP 侧 mio.task.route 落盘；此处 seed 以演示指标可采集。
cat > "$MIO_HOME/route_events.jsonl" <<'JSON'
{"id":"r1","agent":"codex","project":"acme","query":"deploy service with zero downtime","resultIds":["m1"],"resultSources":["experience"],"timestamp":"2026-10-20T00:03:00.000Z"}
JSON

echo "== 3. mio task route（Phase 0 验证闭环）=="
eval "$CLI" task route "deploy service with zero downtime" --project acme

echo "== 4. mio experience confirm =="
eval "$CLI" experience confirm --ids x1 --yes || true

echo "== 5. mio evolution report =="
eval "$CLI" evolution report --period all --project acme

echo "== 6. mio agents evaluation（ADR-017 四指标）=="
eval "$CLI" agents evaluation --project acme

echo "== 7. mio phase0 report =="
eval "$CLI" phase0 report --project acme

echo ""
echo "DEMO COMPLETE. MIO_HOME=$MIO_HOME （可检视后删除）"
