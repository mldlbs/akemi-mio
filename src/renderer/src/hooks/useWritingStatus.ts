import { useState, useEffect } from 'react'

export function useWritingStatus() {
  const [stories, setStories] = useState<any[]>([])
  const [totalScenes, setTotalScenes] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.electronAPI.getWritingStatus().then((result) => {
      setStories(result.stories)
      setTotalScenes(result.totalScenes)
      setLoading(false)
    })
  }, [])

  return { stories, totalScenes, loading }
}
