export function isWallpaperMode(): boolean {
  return !!process.env.WALLPAPER_ENGINE
}

export type WallpaperEvent = 'pause' | 'resume'

export type WallpaperListener = (event: WallpaperEvent) => void

export function onWallpaperEvent(listener: WallpaperListener): () => void {
  if (!isWallpaperMode()) return () => {}

  const handler = (msg: unknown) => {
    if (msg === 'pause' || msg === 'resume') listener(msg)
  }

  process.on('message', handler)
  return () => process.off('message', handler)
}
