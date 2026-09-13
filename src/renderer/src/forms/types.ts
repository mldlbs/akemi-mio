/**
 * 多形态（Multi-form）契约 —— 三形态与主进程窗口工厂的共同真相源。
 *
 * 形态是"人格在不同容器里的呈现"，不是三套独立应用：
 *   pet       宠物小人 —— 桌面角落的常驻形象，透明无边框、置顶、可拖拽
 *   chat      对话框   —— 轻量气泡会话，透明无边框、跟随式、可收起
 *   wallpaper 全屏壁纸 —— 铺满桌面的底层画布，置底、不抢焦点
 *
 * 设计约束：
 * 1. 形态元数据（尺寸/窗口标志/入口）只在这里声明一次，
 *    主进程 Lifecycle 与渲染进程共用，杜绝两边各写一份导致漂移。
 * 2. 这里不引入任何 Electron / Node 依赖 —— 它是纯类型 + 纯数据的模块，
 *    以便渲染进程（sandbox, contextIsolation）也能安全 import。
 */

/** 形态标识。新增形态时在此追加，并补齐 FORM_REGISTRY 中的元数据。 */
export type FormKind = 'pet' | 'chat' | 'wallpaper'

/** 全部形态，供遍历与校验使用（顺序即默认优先级）。 */
export const FORM_KINDS: readonly FormKind[] = ['pet', 'chat', 'wallpaper'] as const

export function isFormKind(value: unknown): value is FormKind {
  return typeof value === 'string' && (FORM_KINDS as readonly string[]).includes(value)
}

/**
 * 形态窗口的静态描述。
 *
 * 注意：窗口标志（transparent/frame/alwaysOnTop 等）在窗口 **创建后不可变**，
 * 这是 Electron 的硬约束。因此形态切换采用"每形态一个常驻窗口、按需显隐"，
 * 而不是复用同一窗口改属性 —— 后者在透明/非透明之间切换必然失败。
 */
export interface FormDescriptor {
  /** 形态标识 */
  kind: FormKind
  /** 中文显示名，用于设置面板与调试日志 */
  label: string
  /** 形态说明，一句话描述它存在的场景 */
  description: string
  /** 生产环境加载的 HTML 文件名（位于 out/renderer/ 下） */
  htmlFile: string
  /** 默认窗口尺寸（像素） */
  size: { width: number; height: number }
  /** 最小尺寸，undefined 表示不限制 */
  minSize?: { width: number; height: number }
  /** 是否无系统边框 */
  frame: boolean
  /** 是否透明背景 */
  transparent: boolean
  /** 是否置顶 */
  alwaysOnTop: boolean
  /**
   * 置顶层级。仅当 alwaysOnTop 为 true 时有意义。
   * 'screen-saver' > 'floating' > 'normal'，壁纸这类"压在桌面、被其他窗口盖住"
   * 的形态用 alwaysOnTop=false + 手动 setAlwaysOnTop(false) 即可。
   */
  alwaysOnTopLevel?: 'floating' | 'screen-saver'
  /** 是否在任务栏中隐藏 */
  skipTaskbar: boolean
  /** 是否可缩放 */
  resizable: boolean
  /** 是否铺满全屏（壁纸形态） */
  fullscreen: boolean
  /** 是否允许鼠标穿透（宠物形态可开启以不挡桌面操作） */
  acceptsMouseEvents: boolean
}

/**
 * 三形态元数据注册表。
 *
 * 窗口尺寸的取值依据：
 * - pet 160x200：够放下一个 Q 版小人 + 轻微呼吸位移，又不至于遮挡桌面图标。
 * - chat 420x560：单列气泡流的舒适宽度，接近 IM 侧栏尺寸。
 * - wallpaper：尺寸由主进程按显示器实际分辨率决定，这里填 0 表示"不预设"。
 */
export const FORM_REGISTRY: Record<FormKind, FormDescriptor> = {
  pet: {
    kind: 'pet',
    label: '宠物小人',
    description: '常驻桌面的小人形象，可拖拽、穿透点击，随情绪与状态变化',
    htmlFile: 'pet.html',
    size: { width: 160, height: 200 },
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    alwaysOnTopLevel: 'floating',
    skipTaskbar: true,
    resizable: false,
    fullscreen: false,
    acceptsMouseEvents: true,
  },
  chat: {
    kind: 'chat',
    label: '对话框',
    description: '轻量气泡会话窗口，随手发问随手收起',
    htmlFile: 'chat.html',
    size: { width: 420, height: 560 },
    minSize: { width: 320, height: 360 },
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    alwaysOnTopLevel: 'floating',
    skipTaskbar: false,
    resizable: true,
    fullscreen: false,
    acceptsMouseEvents: true,
  },
  wallpaper: {
    kind: 'wallpaper',
    label: '全屏壁纸',
    description: '铺满桌面的壁纸层，承载背景内容与轻量信息',
    htmlFile: 'wallpaper.html',
    size: { width: 0, height: 0 },
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    fullscreen: true,
    acceptsMouseEvents: false,
  },
}

/** 宠物情绪 —— 驱动小人表情与配色。 */
export type PetMood = 'idle' | 'happy' | 'thinking' | 'alert' | 'sleepy'

export const PET_MOODS: readonly PetMood[] = ['idle', 'happy', 'thinking', 'alert', 'sleepy'] as const

/** 宠物动作 —— 一次性播放的短动画，播完回归当前情绪。 */
export type PetGesture = 'blink' | 'wave' | 'bounce' | 'tilt'

export interface PetState {
  mood: PetMood
  /** 当前正在播放的动作，null 表示无 */
  gesture: PetGesture | null
}

/** 对话框中的一条消息 —— 独立于主壳的轻量结构。 */
export interface FormMessage {
  id: string
  role: 'user' | 'assistant'
  /** 纯文本内容。渲染层只做换行与链接识别，不解析 Markdown —— 保持轻量。 */
  text: string
  /** 创建时间戳（ms） */
  at: number
  /** assistant 消息是否仍在流式生成 */
  streaming?: boolean
}

/** 跨形态广播的载荷 —— 形态间通过主进程中继，不直接互相引用。 */
export interface FormBroadcast {
  /** 来源形态 */
  from: FormKind
  /** 事件名，如 'pet:mood' / 'chat:message' */
  type: string
  payload: unknown
}

/** preload 暴露给渲染进程的形态 API 契约。 */
export interface FormBridge {
  /** 当前窗口承载的形态 */
  readonly kind: FormKind
  /** 切换指定形态窗口的显隐，返回切换后的可见状态 */
  toggleForm(kind: FormKind): Promise<boolean>
  /** 设置指定形态窗口可见性 */
  setFormVisible(kind: FormKind, visible: boolean): Promise<void>
  /** 查询某形态窗口当前是否可见 */
  isFormVisible(kind: FormKind): Promise<boolean>
  /** 向其他形态广播事件 */
  broadcast(message: FormBroadcast): void
  /** 订阅其他形态广播来的事件，返回取消订阅函数 */
  onBroadcast(handler: (message: FormBroadcast) => void): () => void
  /** 设置鼠标穿透（宠物形态用），true = 忽略鼠标事件 */
  setIgnoreMouseEvents(ignore: boolean): Promise<void>
  /** 拖拽当前窗口（无边框窗口的自定义标题栏拖拽） */
  startWindowDrag(): Promise<void>
  /** 订阅从主窗口镜像来的 agent 事件（形态窗口不在 AgentService 的发送列表里） */
  onAgentMirror(handler: (payload: { channel: string; args: unknown[] }) => void): () => void
}

/**
 * 从主窗口镜像过来的 agent 事件。
 *
 * 存在的原因：AgentService / ChatExecutor 只把事件发给 mainWindow，
 * 形态窗口收不到。主进程在窗口创建时给主窗口的 send 挂了镜像转发，
 * 频道变为 `forms:mirror:<原频道>`。
 */
export type AgentMirrorChannel = 'ai:chunk' | 'tool:status' | 'agent:state'

export interface AgentMirrorEvent {
  channel: AgentMirrorChannel | string
  args: unknown[]
}

/**
 * 把镜像事件归一到"一句话摘要"。
 *
 * 形态窗口不需要完整载荷 —— 宠物只要知道"在干活 / 说了什么 / 出错了"。
 * 这里做归一是为了把解析逻辑收在一处，避免每个形态各写一份脆弱的字段猜测。
 */
export type AgentActivityKind = 'thinking' | 'speaking' | 'tool' | 'done' | 'error'

export interface AgentActivity {
  kind: AgentActivityKind
  /** 可展示的文本（可能为空） */
  text: string
}

/** 工具名 → 中文动作，用于宠物气泡与壁纸信息卡的可读性。 */
export const TOOL_LABELS: Record<string, string> = {
  Read: '读取文件',
  Write: '写入文件',
  Edit: '修改文件',
  Bash: '执行命令',
  Glob: '查找文件',
  Grep: '搜索内容',
  WebFetch: '访问网页',
  WebSearch: '联网搜索',
  Task: '调度子任务',
}

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool
}

