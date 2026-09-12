import { useCallback, useState } from 'react'
import { useBookmarkStore } from '../store/bookmarkStore'
import type { MessageItem } from '../slots/types'

interface BookmarkButtonProps {
  message: MessageItem
  /** 上下文中的其他消息（用于提供对话上下文） */
  contextMessages?: MessageItem[]
}

/** 提取对话上下文中最近的 N 轮，以当前消息为中心 */
function extractContext(
  current: MessageItem,
  allMessages?: MessageItem[],
  maxRounds = 5,
  // role 用 string：MessageItem.role 来自后端自由字符串列，且 bookmarkStore 的
  // 状态类型（bookmarkStore.ts 顶部）本就声明为 string，此处原先写成联合属于自相矛盾。
): Array<{ role: string; content: string; createdAt: number }> {
  if (!allMessages || allMessages.length === 0) {
    return [{ role: current.role, content: current.content, createdAt: current.createdAt }]
  }

  // 找到当前消息在列表中的位置
  const idx = allMessages.findIndex((m) => m.id === current.id)
  if (idx < 0) {
    return [{ role: current.role, content: current.content, createdAt: current.createdAt }]
  }

  // 取当前消息前后各 maxRounds 条消息
  const start = Math.max(0, idx - maxRounds)
  const end = Math.min(allMessages.length, idx + maxRounds + 1)
  return allMessages.slice(start, end).map((m) => ({
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  }))
}

export function BookmarkButton({ message, contextMessages }: BookmarkButtonProps) {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const { createBookmark } = useBookmarkStore()

  const handleBookmark = useCallback(async () => {
    if (loading || done) return
    setLoading(true)

    const context = extractContext(message, contextMessages)
    // 取助手消息的内容作为摘要，用户消息作为补充上下文
    const summary = message.role === 'assistant' ? message.content.slice(0, 150) : message.content.slice(0, 150)

    const success = await createBookmark(summary, context, {
      audioText: summary,
      tags: message.role === 'assistant' ? ['assistant_reply'] : ['user_message'],
    })

    setLoading(false)
    if (success) {
      setDone(true)
      setTimeout(() => setDone(false), 2000)
    }
  }, [message, contextMessages, loading, done, createBookmark])

  return (
    <button
      className={`msg-bm-btn${done ? ' done' : ''}${loading ? ' loading' : ''}`}
      onClick={handleBookmark}
      disabled={loading || done}
      title={done ? '已保存书签' : loading ? '保存中...' : '添加到语音书签'}
    >
      <i className={`ri-${done ? '-bookmark-fill' : loading ? 'loader-4-line ri-spin' : 'bookmark-line'}`} />
    </button>
  )
}
