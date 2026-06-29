export declare class PluginLoader {
    private pluginsDir;
    private loaded;
    private watcher;
    constructor();
    getLoadedPlugins(): string[];
    loadAll(): Promise<void>;
    private loadPlugin;
    unload(name: string): Promise<boolean>;
    unloadAll(): void;
    startWatching(): void;
    stopWatching(): void;
}
