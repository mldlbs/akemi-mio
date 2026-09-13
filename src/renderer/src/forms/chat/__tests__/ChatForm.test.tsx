/**
 * ChatForm 的组件测试。
 *
 * 与 `useChatForm.test.ts`（测 hook 的状态机）分工：这里测的是**组件层**
 * 那部分 hook 测不到的东西 —— 键盘约定、按钮可用性、草稿何时被清空。
 *
 * 重点是一条很容易写错的交互：草稿必须在确认"这次发送真的会发出去"之后才清。
 * 若先清再发，一旦 send 内部早退（空输入 / 发送中），用户刚打的字就凭空消失了
 * —— 表现为"我按了回车，字没了，但什么也没发生"，而且无法复现。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatForm } from '../ChatForm'

const setFormVisibleSpy = vi.fn()
const toggleFormSpy = vi.fn()
let bridgeAvailable = true

vi.mock('../../runtime', () => ({
  hasFormBridge: () => bridgeAvailable,
  setFormVisible: (...args: unknown[]) => {
    setFormVisibleSpy(...args)
    return Promise.resolve(true)
  },
  toggleForm: (...args: unknown[]) => {
    toggleFormSpy(...args)
    return Promise.resolve(true)
  },
  broadcast: () => {},
}))

/** 装一个返回固定回复的桥，避免走 320ms 的降级回声（那会让用例依赖定时器）。 */
function installBridge(reply: string) {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    invoke: async () => reply,
  }
}

function clearBridge() {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
}

function input() {
  return screen.getByPlaceholderText('说点什么…') as HTMLTextAreaElement
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } })
}

beforeEach(() => {
  setFormVisibleSpy.mockClear()
  toggleFormSpy.mockClear()
  bridgeAvailable = true
  installBridge('你好，我是 Mio')
})

afterEach(() => {
  clearBridge()
  vi.restoreAllMocks()
})

describe('ChatForm 基本渲染', () => {
  it('无消息时显示引导空态', () => {
    render(<ChatForm />)
    expect(screen.getByText('想聊点什么？')).toBeTruthy()
    expect(screen.getByText(/Enter 发送/)).toBeTruthy()
  })

  it('有桥接时不显示降级横幅', () => {
    const { container } = render(<ChatForm />)
    expect(container.querySelector('.form-degraded-banner')).toBeNull()
  })

  it('无桥接时显示降级横幅', () => {
    bridgeAvailable = false
    const { container } = render(<ChatForm />)
    expect(container.querySelector('.form-degraded-banner')?.textContent).toContain('预览模式')
  })

  it('清空按钮在无消息时不可用', () => {
    render(<ChatForm />)
    expect((screen.getByLabelText('清空会话') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ChatForm 发送', () => {
  it('发送后同时出现用户消息与助手回复', async () => {
    render(<ChatForm />)
    type('在吗')
    fireEvent.click(screen.getByLabelText('发送'))

    expect(screen.getByText('在吗')).toBeTruthy()
    expect(await screen.findByText('你好，我是 Mio')).toBeTruthy()
    // 空态消失
    expect(screen.queryByText('想聊点什么？')).toBeNull()
  })

  it('发送成功后清空输入框', async () => {
    render(<ChatForm />)
    type('在吗')
    fireEvent.click(screen.getByLabelText('发送'))
    await screen.findByText('你好，我是 Mio')
    expect(input().value).toBe('')
  })

  it('Enter 发送', async () => {
    render(<ChatForm />)
    type('在吗')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(await screen.findByText('你好，我是 Mio')).toBeTruthy()
  })

  it('Shift+Enter 不发送（留给换行）', () => {
    const { container } = render(<ChatForm />)
    type('在吗')
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
    // 用结构而非文本断言：受控 textarea 的 textContent 会被 React 写入，
    // 用 getByText 查会把输入框本身也匹配上。
    expect(container.querySelector('.chat-row-user')).toBeNull()
    // 草稿必须还在
    expect(input().value).toBe('在吗')
  })

  it('空白输入按 Enter 不发送，且草稿不被清掉', () => {
    render(<ChatForm />)
    type('   ')
    fireEvent.keyDown(input(), { key: 'Enter' })
    // 没有任何消息产生
    expect(screen.queryByText('想聊点什么？')).toBeTruthy()
    // 关键：草稿还在。若先清再发，用户打的字会凭空消失。
    expect(input().value).toBe('   ')
  })
})

describe('ChatForm 窗口控制', () => {
  it('Esc 收起对话框', () => {
    render(<ChatForm />)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(setFormVisibleSpy).toHaveBeenCalledWith('chat', false)
  })

  it('点关闭按钮收起', () => {
    render(<ChatForm />)
    fireEvent.click(screen.getByLabelText('收起对话框'))
    expect(setFormVisibleSpy).toHaveBeenCalledWith('chat', false)
  })

  it('切到宠物形态走 toggleForm', () => {
    render(<ChatForm />)
    fireEvent.click(screen.getByLabelText('切换到宠物形态'))
    expect(toggleFormSpy).toHaveBeenCalledWith('pet')
  })

  it('有消息后清空按钮可用，点击回到空态', async () => {
    render(<ChatForm />)
    type('在吗')
    fireEvent.click(screen.getByLabelText('发送'))
    await screen.findByText('你好，我是 Mio')

    const clearBtn = screen.getByLabelText('清空会话') as HTMLButtonElement
    expect(clearBtn.disabled).toBe(false)
    fireEvent.click(clearBtn)
    expect(screen.getByText('想聊点什么？')).toBeTruthy()
  })
})

describe('ChatForm 桥不可用时的降级', () => {
  it('桥缺失时仍能走完流程（本地回声）', async () => {
    clearBridge()
    render(<ChatForm />)
    type('在吗')
    fireEvent.click(screen.getByLabelText('发送'))
    expect(screen.getByText('在吗')).toBeTruthy()
    expect(await screen.findByText(/预览模式，未连接后端/)).toBeTruthy()
  })
})
