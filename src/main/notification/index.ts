/**
 * notification — 事件通知系统
 *
 * 提供事件驱动的语音通知能力：
 * - TtsEventNotificationService: 订阅 EventBus 工具事件，自动生成语音播报
 * - createAndStartTtsEventNotifier(): 快捷工厂函数
 * - ttsEventNotifier: 全局单例
 */

export {
  TtsEventNotificationService,
  ttsEventNotifier,
  createAndStartTtsEventNotifier,
} from './TtsEventNotificationService'

export type { NotifyEventType } from './TtsEventNotificationService'
