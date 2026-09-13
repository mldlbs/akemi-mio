/**
 * 把主壳的 agent 状态同步给桌面形态。
 *
 * 为什么需要它：真实对话状态（thinking / tool_executing / replying / idle）
 * 只存在于主壳的 zustand store 里，主进程和形态窗口都看不见。
 * 宠物因此无法知道"用户刚发问、模型还没吐出第一个字" —— 而这段空窗期
 * 恰恰是它最该显示"思考中"的时候。
 *
 * 为什么订阅 store 而不是在每个 setAgentState 调用点加广播：
 * 调用点散落在 useAIOutput / 各处错误处理里，逐个加必然漏。
 * 订阅 store 能覆盖**所有**状态变化，且主壳无需知道形态的存在。
 *
 * 幂等：只在状态真正变化时才广播（zustand subscribe 本身就去重，
 * 但这里仍显式比对，避免 store 其它字段变化时的无谓 IPC）。
 */

import { useEffect } from 'react'
import { useAgentStore, type AgentState } from '../store/agentStore'
import { broadcast } from '../forms/runtime'

/**
 * 主壳 AgentState → 广播出去的状态名。
 * 形态侧按自己的语义消费（宠物映射为情绪）。
 */
export type BroadcastAgentState = 'thinking' | 'tool' | 'replying' | 'idle'

const STATE_MAP: Record<AgentState, BroadcastAgentState> = {
  idle: 'idle',
  thinking: 'thinking',
  tool_executing: 'tool',
  replying: 'replying',
}

/**
 * 订阅 agent 状态变化并广播。
 * 在 App 根组件调用一次即可。
 */
export function useFormAgentSync(): void {
  useEffect(() => {
    // 取初始值，避免订阅首帧就广播一次冗余事件
    let last: AgentState = useAgentStore.getState().agentState

    const unsubscribe = useAgentStore.subscribe((state) => {
      const next = state.agentState
      if (next === last) return
      last = next

      broadcast('agent:state', { state: STATE_MAP[next] })
    })

    return unsubscribe
  }, [])
}
