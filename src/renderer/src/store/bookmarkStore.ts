import { create } from 'zustand'

/** 从 IPC 返回的书签对象 */
export interface BookmarkItem {
  id: string
  summary: string
  audioPath: string
  audioText: string
  tags: string[]
  isFavorite: boolean
  bookmarkedAt: number
  conversationContext: Array<{ role: string; content: string; createdAt: number }>
  ttsDurationMs: number
}

interface BookmarkState {
  /** 所有书签列表 */
  bookmarks: BookmarkItem[]
  /** 是否正在加载 */
  loading: boolean
  /** 当前选中的书签 ID */
  selectedId: string | null
  /** 搜索结果 */
  searchResults: BookmarkItem[] | null
  /** 搜索关键词 */
  searchQuery: string

  // Actions
  setBookmarks: (bookmarks: BookmarkItem[]) => void
  setLoading: (loading: boolean) => void
  setSelectedId: (id: string | null) => void
  setSearchResults: (results: BookmarkItem[] | null) => void
  setSearchQuery: (query: string) => void
  addBookmark: (bookmark: BookmarkItem) => void
  removeBookmark: (id: string) => void
  toggleFavorite: (id: string) => void

  // Async actions
  fetchBookmarks: () => Promise<void>
  searchBookmarks: (query: string) => Promise<void>
  deleteBookmark: (id: string) => Promise<boolean>
  createBookmark: (
    summary: string,
    conversationContext: Array<{ role: 'user' | 'assistant'; content: string; createdAt: number }>,
    options?: { audioText?: string; tags?: string[] },
  ) => Promise<boolean>
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: [],
  loading: false,
  selectedId: null,
  searchResults: null,
  searchQuery: '',

  setBookmarks: (bookmarks) => set({ bookmarks }),
  setLoading: (loading) => set({ loading }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  addBookmark: (bookmark) =>
    set((state) => ({ bookmarks: [bookmark, ...state.bookmarks] })),
  removeBookmark: (id) =>
    set((state) => ({
      bookmarks: state.bookmarks.filter((b) => b.id !== id),
      searchResults: state.searchResults?.filter((b) => b.id !== id) ?? null,
    })),
  toggleFavorite: (id) =>
    set((state) => ({
      bookmarks: state.bookmarks.map((b) =>
        b.id === id ? { ...b, isFavorite: !b.isFavorite } : b,
      ),
      searchResults: state.searchResults?.map((b) =>
        b.id === id ? { ...b, isFavorite: !b.isFavorite } : b,
      ) ?? null,
    })),

  fetchBookmarks: async () => {
    set({ loading: true })
    try {
      const result = await window.electronAPI.voiceBookmarkList(100, 0)
      if (result.success) {
        set({ bookmarks: result.bookmarks, loading: false })
      } else {
        set({ loading: false })
      }
    } catch {
      set({ loading: false })
    }
  },

  searchBookmarks: async (query: string) => {
    set({ searchQuery: query })
    if (!query.trim()) {
      set({ searchResults: null })
      return
    }
    try {
      const result = await window.electronAPI.voiceBookmarkSearch(query)
      if (result.success) {
        set({ searchResults: result.bookmarks })
      }
    } catch {
      // ignore
    }
  },

  deleteBookmark: async (id: string) => {
    try {
      const result = await window.electronAPI.voiceBookmarkDelete(id)
      if (result.success) {
        get().removeBookmark(id)
        return true
      }
      return false
    } catch {
      return false
    }
  },

  createBookmark: async (summary, conversationContext, options?) => {
    try {
      const result = await window.electronAPI.voiceBookmarkCreate(summary, conversationContext, options)
      if (result.success && result.bookmark) {
        const fullResult = await window.electronAPI.voiceBookmarkGet(result.bookmark.id)
        if (fullResult.success && fullResult.bookmark) {
          get().addBookmark(fullResult.bookmark)
        }
        return true
      }
      return false
    } catch {
      return false
    }
  },
}))
