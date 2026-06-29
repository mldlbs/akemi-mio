export function isWallpaperMode() {
    return !!process.env.WALLPAPER_ENGINE;
}
export function onWallpaperEvent(listener) {
    if (!isWallpaperMode())
        return () => { };
    const handler = (msg) => {
        if (msg === 'pause' || msg === 'resume')
            listener(msg);
    };
    process.on('message', handler);
    return () => process.off('message', handler);
}
