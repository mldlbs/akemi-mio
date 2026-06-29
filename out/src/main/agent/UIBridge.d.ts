import { BrowserWindow } from 'electron';
/**
 * UIBridge — 将 EventBus 事件桥接到 Renderer IPC
 *
 * 职责：
 * - 订阅 Agent 相关 EventBus 事件
 * - 通过 webContents.send 转发到渲染进程
 * - 生命周期与 mainWindow 绑定
 */
export declare class UIBridge {
    private mainWindow;
    private disposers;
    /** 绑定窗口，开始转发 */
    bind(win: BrowserWindow): void;
    /** 解绑窗口，停止转发 */
    unbind(): void;
    private send;
    private listen;
    private startListening;
}
