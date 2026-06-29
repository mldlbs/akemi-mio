import type { EventStoreEngine } from '../../core/EventBusTypes';
/**
 * EventReplayer — 启动时重放持久化事件恢复状态
 *
 * 接收已注册的 EventBus 实例和 EventStore，查询自指定时间点之后的事件
 * 并按顺序重放到订阅者。
 */
export declare class EventReplayer {
    private store;
    constructor(store: EventStoreEngine);
    /**
     * 重放指定 channel 的事件到 eventBus。
     */
    replay(eventBus: any, channels: string[], sinceTimestamp: number): Promise<number>;
}
