// types.ts 里的 ToolEvent 已更名为 ToolIPCEvent（它是 IPC 负载形状，不是 FSM 事件），
// 这里的 re-export 名单没跟上，导致 barrel 长期 TS2724。注意 FSM 侧的 ToolEvent 另有
// 出处：src/renderer/src/tool/toolTypes.ts。
export type { SessionItem, MessageItem, ToolIPCEvent, UiState, ActiveSlot } from './types'
