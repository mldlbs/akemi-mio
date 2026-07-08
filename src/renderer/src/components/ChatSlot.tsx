import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useAgentStore } from '../store/agentStore'
import type { AgentState } from '../store/agentStore'
import { isToolActive } from '../tool/toolTypes'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }, [text])

  return (
    <button className={`msg-copy-btn${copied ? ' copied' : ''}`} onClick={handleCopy} title="复制">
      <i className={`ri-${copied ? 'check-line' : 'file-copy-line'}`} />
    </button>
  )
}

const AGENT_LABELS: Record<AgentState, string | null> = {
  idle: null,
  thinking: '思考中…',
  tool_executing: '执行工具…',
  replying: null,
}

function humanToolName(tool: string): string {
  const n = tool
  if (n === 'read_file') return '读取文件'
  if (n === 'edit_file') return '编辑文件'
  if (n === 'write_file') return '写入文件'
  if (n === 'run_command') return '执行命令'
  if (n === 'grep' || n === 'grep_code') return '搜索代码'
  if (n === 'list_files') return '浏览目录'
  if (n === 'remember_fact') return '记忆事实'
  if (n === 'analyze_task') return '分析任务'
  if (n === 'list_workflows') return '查看工作流'
  if (n === 'create_workflow') return '创建工作流'
  if (n === 'start_workflow') return '启动工作流'
  if (n === 'get_workflow_status') return '工作流状态'
  if (n === 'create_dev_plan') return '创建设计方案'
  if (n === 'update_plan_progress') return '更新计划进度'
  if (n === 'list_plans') return '查看设计方案'
  if (n === 'query_trends') return '查询热搜'
  if (n === 'generate_image') return '生成图片'
  if (n === 'card_generator') return '生成卡片'
  if (n.startsWith('centos_')) return n.replace('centos_', '远程-')
  return n
}

function summarizeArgs(tool: string, args: Record<string, any>): string {
  const v = (key: string) => (args[key] ?? '').toString().slice(0, 60)
  if (tool === 'run_command') return v('command')
  if (tool === 'read_file') return v('path').split('/').pop() || v('file_path').split('/').pop() || v('path')
  if (tool === 'edit_file' || tool === 'write_file') return v('path').split('/').pop() || v('path')
  if (tool === 'grep' || tool === 'grep_code') return v('pattern')
  if (tool === 'list_files') return v('path')
  if (tool === 'create_workflow') return v('name')
  if (tool === 'start_workflow') return v('workflowId')
  return Object.values(args)
    .filter((v) => typeof v === 'string')
    .map((s) => s.slice(0, 30))
    .join(' ')
    .slice(0, 80)
}

/** 纯消息列表子组件 — 仅订阅 messages，不受 pendingText/tools 变化影响 */
const MessageList = React.memo(function MessageList({
  bottomRef,
  onMessageCount,
}: {
  bottomRef: React.RefObject<HTMLDivElement | null>
  onMessageCount?: (n: number) => void
}) {
  const messages = useSessionStore((s) => s.historyMessages)

  const prevLen = useRef(0)
  useEffect(() => {
    onMessageCount?.(messages.length)
    if (messages.length > prevLen.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    }
    prevLen.current = messages.length
  }, [messages, bottomRef, onMessageCount])

  return (
    <>
      {messages.map((m) => (
        <div key={m.id} className={`msg msg-row ${m.role}`}>
          <div className="msg-label">{m.role === 'user' ? '你' : '秋山澪'}</div>
          <div className="msg-bubble">{m.content}</div>
          <div className="msg-actions">
            <CopyButton text={m.content} />
            <span className="msg-time">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      ))}
    </>
  )
})

export function ChatSlot() {
  const historyLoading = useSessionStore((s) => s.historyLoading)

  const pendingText = useAgentStore((s) => s.pendingText)
  const displayText = useAgentStore((s) => s.displayText)
  const transcribed = useAgentStore((s) => s.transcribed)
  const agentState = useAgentStore((s) => s.agentState)
  const tools = useAgentStore((s) => s.tools)

  const toolRunning = useMemo(() => tools.filter(isToolActive), [tools])
  const toolCompleted = useMemo(() => tools.filter((t) => !isToolActive(t)), [tools])

  const bottomRef = useRef<HTMLDivElement>(null)
  const [toolsCollapsed, setToolsCollapsed] = useState(false)
  const [messageCount, setMessageCount] = useState(0)

  // 只在 pendingText 或 displayText 变化时滚到底部（禁止 JS 动画避免与 React 渲染竞争）
  useEffect(() => {
    if (pendingText || displayText) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [pendingText, displayText])

  const hasPending = !!pendingText
  const agentLabel = AGENT_LABELS[agentState]
  const hasTools = toolRunning.length > 0 || toolCompleted.length > 0
  const showEmpty = messageCount === 0 && !hasPending && !transcribed && !hasTools && !agentLabel && !historyLoading

  const toolSummary = useMemo(() => {
    const allTools = [...toolRunning, ...toolCompleted]
    const names = [...new Set(allTools.map((t) => humanToolName(t.tool)))]
    if (names.length === 0) return ''
    if (names.length <= 2) return names.join('、')
    return `${names[0]} 等 ${names.length} 个工具`
  }, [toolRunning, toolCompleted])

  if (historyLoading) {
    return (
      <div className="chat-slot">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <i className="ri-loader-4-line ri-spin" />
          </div>
          <div className="chat-empty-text">加载中…</div>
        </div>
      </div>
    )
  }

  if (showEmpty) {
    return (
      <div className="chat-slot">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <i className="ri-chat-1-line" />
          </div>
          <div className="chat-empty-text">开始一段新对话</div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-slot">
      {agentLabel && (
        <div className="agent-indicator">
          <span className="agent-indicator-dot" />
          <span className="agent-indicator-text">{agentLabel}</span>
        </div>
      )}

      {transcribed && (
        <div className="msg msg-row user">
          <div className="msg-label">你</div>
          <div className="msg-bubble">{transcribed}</div>
          <div className="msg-actions">
            <CopyButton text={transcribed} />
          </div>
        </div>
      )}

      {/* 消息列表独立组件，不受 pendingText/tools 重渲染影响 */}
      <MessageList bottomRef={bottomRef} onMessageCount={setMessageCount} />

      {toolRunning.length > 0 && (
        <div className="tool-inline-group">
          <div
            className={`tool-inline-group-header${toolsCollapsed ? '' : ' expanded'}`}
            onClick={() => setToolsCollapsed(!toolsCollapsed)}
          >
            <i className={`ri-arrow-${toolsCollapsed ? 'right' : 'down'}-s-line`} />
            <i className="ri-loader-4-line ri-spin tool-group-running-icon" />
            <span className="tool-group-summary">{toolSummary}</span>
            <span className="tool-group-count">{toolRunning.length}</span>
          </div>
          {!toolsCollapsed && (
            <div className="tool-inline-items">
              {toolRunning.map((t) => (
                <div key={t.id} className="tool-inline tool-inline-running">
                  <i className="ri-loader-4-line ri-spin" />
                  <span className="tool-inline-name">{humanToolName(t.tool)}</span>
                  {t.args && <span className="tool-inline-args">{summarizeArgs(t.tool, t.args)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {toolCompleted.length > 0 && (
        <div className="tool-inline-group">
          <div className="tool-inline-group-header tool-group-completed-header">
            <i className="ri-check-line tool-group-done-icon" />
            <span className="tool-group-summary">完成 {toolCompleted.length} 个工具</span>
          </div>
          <div className="tool-inline-items">
            {toolCompleted.map((t) => {
              const isError = t.status === 'error'
              return (
                <div key={t.id} className={`tool-inline ${isError ? 'tool-inline-failed' : 'tool-inline-done'}`}>
                  <i className={`ri-${isError ? 'close-circle-line' : 'check-line'}`} />
                  <span className="tool-inline-name">{humanToolName(t.tool)}</span>
                  <span className="tool-inline-meta">{(t.latencyMs / 1000).toFixed(1)}s</span>
                  {isError && <span className="tool-inline-error">{t.error}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {hasPending && (
        <div className="msg msg-row assistant">
          <div className="msg-label">秋山澪</div>
          <div className="msg-bubble">
            {displayText || pendingText}
            <span className="msg-cursor" />
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
