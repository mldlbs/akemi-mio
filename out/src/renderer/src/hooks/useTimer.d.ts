/**
 * 声明式 setTimeout hook
 *
 * @param callback - 超时回调
 * @param delayMs  - 延迟毫秒数，传入 null 暂停
 *
 * 用法：
 * ```ts
 * useTimeout(() => setText(''), delay)
 * ```
 */
export declare function useTimeout(callback: () => void, delayMs: number | null): void;
/**
 * 声明式 setInterval hook
 *
 * @param callback - 间隔回调
 * @param intervalMs - 间隔毫秒数，传入 null 暂停
 *
 * 用法：
 * ```ts
 * useInterval(() => setI(i => i + 1), 1000)
 * ```
 */
export declare function useInterval(callback: () => void, intervalMs: number | null): void;
/**
 * 手动控制的定时器 hook（兼容 fadeTimer / revealTimer 等 ref 模式）
 *
 * 返回 set/clear 方法，组件卸载时自动清理
 *
 * 用法：
 * ```ts
 * const reveal = useTimerControl()
 * // 开始
 * reveal.setInterval(() => { i++; if (done) reveal.clear() }, 20)
 * // 清除
 * reveal.clear()
 * ```
 */
export declare function useTimerControl(): {
    set: (fn: () => void, delay: number) => void;
    setInterval: (fn: () => void, interval: number) => void;
    clear: () => void;
};
