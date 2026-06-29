import { BrowserWindow } from 'electron';
/**
 * 调用 DwmSetWindowAttribute 禁用 DWM 非客户区渲染策略
 * 从根本上阻止 Windows 11 透明无边框窗口失焦时绘制白边
 */
export declare function disableNCRendering(win: BrowserWindow): void;
