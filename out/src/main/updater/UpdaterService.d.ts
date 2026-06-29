import { BrowserWindow } from 'electron';
export declare function setUpdateWindow(win: BrowserWindow): void;
export declare function initUpdater(): void;
export declare function checkForUpdates(): Promise<{
    available: boolean;
    version?: string;
}>;
export declare function downloadUpdate(): Promise<void>;
export declare function quitAndInstall(): void;
