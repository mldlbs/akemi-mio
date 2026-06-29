import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { toolRegistry } from './registry';
function getStorageDir() {
    const dir = join(app.getPath('userData'), 'plugin-storage');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
function getStoragePath(pluginName) {
    const safeName = pluginName.replace(/[^a-zA-Z0-9._@-]/g, '_');
    return join(getStorageDir(), `${safeName}.json`);
}
function loadPersistentStore(pluginName) {
    const path = getStoragePath(pluginName);
    try {
        if (existsSync(path)) {
            return JSON.parse(readFileSync(path, 'utf-8'));
        }
    }
    catch {
        // 存储文件损坏时重新开始
    }
    return {};
}
function savePersistentStore(pluginName, data) {
    try {
        writeFileSync(getStoragePath(pluginName), JSON.stringify(data, null, 2), 'utf-8');
    }
    catch (err) {
        console.error(`[PluginStorage] 保存 ${pluginName} 存储失败:`, err);
    }
}
export function createPluginAPI(pluginName) {
    const persistentData = loadPersistentStore(pluginName);
    // 自动保存：定期 flush，但使用简单的同步保存策略
    let saveTimer = null;
    const scheduleSave = () => {
        if (saveTimer)
            clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            savePersistentStore(pluginName, persistentData);
            saveTimer = null;
        }, 2000);
    };
    return {
        getToolRegistry: () => toolRegistry,
        storage: {
            get(key) {
                return persistentData[key];
            },
            set(key, value) {
                persistentData[key] = value;
                scheduleSave();
            },
            delete(key) {
                delete persistentData[key];
                scheduleSave();
            },
        },
        logger: {
            info(event, data) {
                console.log(JSON.stringify({ level: 'INFO', plugin: pluginName, event, ...data }));
            },
            warn(event, data) {
                console.warn(JSON.stringify({ level: 'WARN', plugin: pluginName, event, ...data }));
            },
            error(event, data) {
                console.error(JSON.stringify({ level: 'ERROR', plugin: pluginName, event, ...data }));
            },
        },
        http: {
            async get(url, options) {
                const res = await fetch(url, { method: 'GET', ...options });
                return { status: res.status, data: await res.json() };
            },
            async post(url, body, options) {
                const res = await fetch(url, {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers: { 'Content-Type': 'application/json' },
                    ...options,
                });
                return { status: res.status, data: await res.json() };
            },
        },
    };
}
