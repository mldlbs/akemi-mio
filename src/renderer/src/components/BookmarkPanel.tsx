import { useEffect, useState, useCallback, useRef } from 'react'
import { useBookmarkStore, type BookmarkItem } from '../store/bookmarkStore'

/** 格式化时间戳为人类可读字符串 */
function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/**
 * 语音记忆书签面板
 *
 * 显示所有语音书签，支持搜索、播放、收藏、删除。
 * 集成在右侧面板中作为独立的 tab，或作为独立浮层。
 */
export function BookmarkPanel() {
  const {
    bookmarks,
    loading,
    searchResults,
    searchQuery,
    fetchBookmarks,
    searchBookmarks,
    setSearchQuery,
    deleteBookmark,
    toggleFavorite: toggleFavoriteInStore,
  } = useBookmarkStore()

  const [playingId, setPlayingId] = useState<string | null>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 首次加载
  useEffect(() => {
    fetchBookmarks()
  }, [fetchBookmarks])

  /** 搜索去抖 */
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value)
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      searchTimerRef.current = setTimeout(() => {
        searchBookmarks(value)
      }, 300)
    },
    [setSearchQuery, searchBookmarks],
  )

  /** 播放书签语音 */
  const handlePlay = useCallback(
    async (bookmark: BookmarkItem) => {
      if (playingId === bookmark.id) {
        // 点击正在播放的项 => 停止
        if (audioRef.current) {
          audioRef.current.pause()
          audioRef.current = null
        }
        setPlayingId(null)
        return
      }

      try {
        // 先获取音频路径
        const pathResult = await window.electronAPI.voiceBookmarkGetAudioPath(bookmark.id)
        if (!pathResult.success || !pathResult.audioPath) {
          console.warn('音频文件不可用:', bookmark.id)
          return
        }

        // 将文件路径转为可播放的 URL
        // Electron 中文件协议需要通过 webSecurity 或自定义协议播放
        const audioUrl = `file://${pathResult.audioPath.replace(/\\/g, '/')}`

        if (audioRef.current) {
          audioRef.current.pause()
          audioRef.current = null
        }

        const audio = new Audio(audioUrl)
        audioRef.current = audio
        setPlayingId(bookmark.id)

        audio.onended = () => {
          setPlayingId(null)
          audioRef.current = null
        }
        audio.onerror = () => {
          // 如果 file:// 协议不支持，尝试通过 IPC 播放
          window.electronAPI.speak(bookmark.audioText || bookmark.summary)
          setPlayingId(null)
          audioRef.current = null
        }

        await audio.play()
      } catch (err) {
        console.warn('书签播放失败，回退到 TTS:', err)
        // 回退：用 TTS 朗读文本
        try {
          await window.electronAPI.speak(bookmark.audioText || bookmark.summary)
        } catch {}
        setPlayingId(null)
        audioRef.current = null
      }
    },
    [playingId],
  )

  /** 删除书签 */
  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const confirmed = confirm('确定删除此语音书签？关联的音频文件也将被删除。')
      if (!confirmed) return
      if (playingId === id) {
        if (audioRef.current) {
          audioRef.current.pause()
          audioRef.current = null
        }
        setPlayingId(null)
      }
      await deleteBookmark(id)
    },
    [deleteBookmark, playingId],
  )

  /** 切换收藏 */
  const handleToggleFavorite = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        const result = await window.electronAPI.voiceBookmarkToggleFavorite(id)
        if (result.success) {
          toggleFavoriteInStore(id)
        }
      } catch {}
    },
    [toggleFavoriteInStore],
  )

  const displayList = searchResults ?? bookmarks
  const hasResults = displayList.length > 0

  return (
    <div className="bookmark-panel">
      {/* 标题与刷新 */}
      <div className="bookmark-panel-header">
        <span className="bookmark-panel-count">{searchResults ? `${displayList.length} 个结果` : `${bookmarks.length} 条记录`}</span>
        <button className="bookmark-panel-refresh" onClick={fetchBookmarks} title="刷新" aria-label="刷新书签">
          <i className={`ri-refresh-line${loading ? ' ri-spin' : ''}`} />
          <span className="bookmark-refresh-fallback" aria-hidden="true">
            ↻
          </span>
        </button>
      </div>

      {/* 搜索栏 */}
      <div className={`bookmark-search${searchFocused ? ' focused' : ''}`}>
        <i className="ri-search-line bookmark-search-icon" />
        <input
          type="text"
          className="bookmark-search-input"
          placeholder="搜索书签..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        />
        {searchQuery && (
          <button className="bookmark-search-clear" onClick={() => handleSearchChange('')}>
            <i className="ri-close-line" />
          </button>
        )}
      </div>

      {/* 书签列表 */}
      <div className="bookmark-list">
        {loading && bookmarks.length === 0 ? (
          <div className="bookmark-empty">
            <i className="ri-loader-4-line ri-spin bookmark-empty-icon" />
            <span>加载中...</span>
          </div>
        ) : !hasResults ? (
          <div className="bookmark-empty">
            <i className="ri-bookmark-3-line bookmark-empty-icon" />
            <span>{searchQuery ? '未找到匹配的书签' : '暂无语音书签'}</span>
          </div>
        ) : (
          displayList.map((bookmark) => (
            <div
              key={bookmark.id}
              className={`bookmark-item${playingId === bookmark.id ? ' playing' : ''}${bookmark.isFavorite ? ' favorite' : ''}`}
              onClick={() => handlePlay(bookmark)}
            >
              {/* 顶部行：摘要与操作按钮 */}
              <div className="bookmark-item-top">
                <div className="bookmark-item-summary" title={bookmark.summary}>
                  {bookmark.summary.length > 60 ? bookmark.summary.slice(0, 57) + '...' : bookmark.summary}
                </div>
                <div className="bookmark-item-actions">
                  {/* 收藏按钮 */}
                  <button
                    className={`bookmark-action-btn${bookmark.isFavorite ? ' favorited' : ''}`}
                    onClick={(e) => handleToggleFavorite(bookmark.id, e)}
                    title={bookmark.isFavorite ? '取消收藏' : '收藏'}
                  >
                    <i className={`ri-star-${bookmark.isFavorite ? 'fill' : 'line'}`} />
                  </button>
                  {/* 播放按钮 */}
                  <button
                    className="bookmark-action-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      handlePlay(bookmark)
                    }}
                    title={playingId === bookmark.id ? '停止' : '播放'}
                  >
                    <i className={`ri-${playingId === bookmark.id ? 'stop-circle-line' : 'play-circle-line'}`} />
                  </button>
                  {/* 删除按钮 */}
                  <button className="bookmark-action-btn bookmark-action-delete" onClick={(e) => handleDelete(bookmark.id, e)} title="删除">
                    <i className="ri-delete-bin-line" />
                  </button>
                </div>
              </div>

              {/* 底部信息行 */}
              <div className="bookmark-item-bottom">
                {bookmark.audioPath && (
                  <span className="bookmark-item-audio-badge">
                    <i className="ri-volume-up-line" />
                    {bookmark.ttsDurationMs > 0 ? `${(bookmark.ttsDurationMs / 1000).toFixed(1)}s` : '有声'}
                  </span>
                )}
                {bookmark.tags.length > 0 && (
                  <span className="bookmark-item-tags">
                    {bookmark.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="bookmark-item-tag">
                        #{tag}
                      </span>
                    ))}
                  </span>
                )}
                <span className="bookmark-item-time">{formatTime(bookmark.bookmarkedAt)}</span>
                {bookmark.isFavorite && <i className="ri-star-fill bookmark-item-fav-icon" />}
              </div>

              {/* 对话上下文预览（收起时只显示1条） */}
              {bookmark.conversationContext.length > 0 && (
                <div className="bookmark-item-context">
                  <div className="bookmark-context-entry">
                    <span className="bookmark-context-role">{bookmark.conversationContext[0].role === 'user' ? '你' : 'AI'}</span>
                    <span className="bookmark-context-text">
                      {bookmark.conversationContext[0].content.slice(0, 80)}
                      {bookmark.conversationContext[0].content.length > 80 ? '...' : ''}
                    </span>
                  </div>
                  {bookmark.conversationContext.length > 1 && (
                    <span className="bookmark-context-more">+{bookmark.conversationContext.length - 1} 条上下文</span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
