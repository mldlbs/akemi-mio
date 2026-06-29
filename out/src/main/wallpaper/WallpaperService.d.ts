export declare function isWallpaperMode(): boolean;
export type WallpaperEvent = 'pause' | 'resume';
export type WallpaperListener = (event: WallpaperEvent) => void;
export declare function onWallpaperEvent(listener: WallpaperListener): () => void;
