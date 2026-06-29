import './ort-log';
import { app } from 'electron';
import { AppRuntime } from './bootstrap/AppRuntime';
// 透明窗口：阻止 Chromium 在失焦时暂停合成渲染，防止 DWM 刷白
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 全局崩溃防护
import { log } from './logger/Logger';
const crashGuard = { flushMemory: null };
process.on('uncaughtException', (error) => {
    try {
        log('ERROR', 'crash_uncaught_exception', { error: String(error), stack: error.stack?.slice(0, 500) });
    }
    catch { }
    try {
        crashGuard.flushMemory?.();
    }
    catch { }
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    try {
        log('ERROR', 'crash_unhandled_rejection', { reason: String(reason) });
    }
    catch { }
});
// 启动
const runtime = new AppRuntime(crashGuard);
runtime.start();
