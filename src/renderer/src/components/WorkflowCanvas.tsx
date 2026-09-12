import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { configPathFor, type StepDef, type FieldDef } from './WorkflowEditor'

interface Props {
  steps: StepDef[]
  editingStepId: string | null
  onSelectStep: (id: string) => void
  onDeselectStep?: () => void
  onAddStep: () => void
  onDeleteStep: (id: string) => void
  onDuplicateStep: (id: string) => void
  onContextMenu: (x: number, y: number, stepId: string | null) => void
  onAddNodeRequest?: (x: number, y: number) => void
  onConnect?: (fromId: string, toId: string) => void
  onEdgeContextMenu?: (x: number, y: number, fromId: string, toId: string) => void
  onRenameStep?: (id: string, name: string) => void
  onSelectionChange?: (ids: string[]) => void
  onDisconnectInputs?: (toId: string) => void
  runningStepIds?: Set<string>
  inlineFields?: FieldDef[]
  onUpdateStepConfig?: (id: string, config: Record<string, any>) => void
  onUpdateStep?: (id: string, patch: Partial<StepDef>) => void
  onOpenDrawer?: () => void
}

interface EdgeEntry {
  id: string
  idx: number
  fromId: string
  toId: string
  failure: boolean
  running: boolean
  conditionLabel?: string
}

const HANDLER_ICONS: Record<string, string> = {
  subagent: 'ri-robot-2-line',
  prompt: 'ri-question-mark',
  tool: 'ri-tools-line',
  api: 'ri-api-line',
  plan: 'ri-file-list-3-line',
  condition: 'ri-git-branch-line',
  foreach: 'ri-loop-left-line',
  transform: 'ri-exchange-2-line',
  gate: 'ri-lock-2-line',
  aggregate: 'ri-folder-5-line',
  subflow: 'ri-organization-chart',
  wait: 'ri-timer-line',
  script: 'ri-terminal-box-line',
  event: 'ri-notification-3-line',
}
const HANDLER_LABELS: Record<string, string> = {
  subagent: '子Agent',
  prompt: 'Prompt',
  tool: 'Tool',
  api: 'API',
  plan: 'Plan',
  condition: '条件',
  foreach: '循环',
  transform: '变换',
  gate: '审批',
  aggregate: '聚合',
  subflow: '子流程',
  wait: '等待',
  script: '脚本',
  event: '事件',
}
const HANDLER_COLORS: Record<string, string> = {
  subagent: 'oklch(0.65 0.18 240)',
  prompt: 'oklch(0.65 0.12 80)',
  tool: 'oklch(0.55 0.14 160)',
  api: 'oklch(0.55 0.16 300)',
  plan: 'oklch(0.55 0.12 30)',
  condition: 'oklch(0.6 0.2 280)',
  foreach: 'oklch(0.55 0.16 180)',
  transform: 'oklch(0.55 0.14 200)',
  gate: 'oklch(0.6 0.18 80)',
  aggregate: 'oklch(0.5 0.12 260)',
  subflow: 'oklch(0.5 0.14 220)',
  wait: 'oklch(0.5 0.1 240)',
  script: 'oklch(0.5 0.12 10)',
  event: 'oklch(0.55 0.16 320)',
}

const NODE_W = 210
const NODE_W_INLINE = 268
const NODE_H = 104
const PORT_OFFSET = 76
const H_SPACING = 264
const V_SPACING = 148
const OFFSET_X = 56
const OFFSET_Y = 44
const MIN_ZOOM = 0.18
const MAX_ZOOM = 2.5
const FIT_MAX_ZOOM = 1.25

function dagLayout(
  steps: StepDef[],
  preExisting: Record<string, { x: number; y: number }>,
  always = false,
): Record<string, { x: number; y: number }> {
  if (steps.length === 0) return {}
  const idSet = new Set(steps.map((s) => s.id))
  const deps = new Map<string, string[]>()
  for (const s of steps)
    deps.set(
      s.id,
      s.dependsOn.filter((d) => idSet.has(d)),
    )
  const layer = new Map<string, number>()
  function getLayer(id: string): number {
    if (layer.has(id)) return layer.get(id)!
    const d = deps.get(id) ?? []
    if (d.length === 0) {
      layer.set(id, 0)
      return 0
    }
    const l = 1 + Math.max(...d.map(getLayer))
    layer.set(id, l)
    return l
  }
  for (const s of steps) getLayer(s.id)
  const byLayer = new Map<number, string[]>()
  let maxLayer = 0
  for (const s of steps) {
    const l = layer.get(s.id)!
    if (l > maxLayer) maxLayer = l
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(s.id)
  }
  const result: Record<string, { x: number; y: number }> = {}
  if (!always) for (const [k, v] of Object.entries(preExisting)) result[k] = v

  function takenList(): { x: number; y: number }[] {
    return Object.values(result)
  }
  function avoidOverlap(candidate: { x: number; y: number }): { x: number; y: number } {
    let p = candidate
    let guard = 0
    while (takenList().some((t) => Math.abs(t.x - p.x) < NODE_W * 0.8 && Math.abs(t.y - p.y) < NODE_H * 0.8) && guard < 200) {
      p = { x: p.x, y: p.y + V_SPACING }
      guard++
    }
    return p
  }

  // Pure chains: wrap into columns so long pipelines fill the canvas instead
  // of degenerating into a single tall column.
  const isChain = steps.every((s) => s.dependsOn.filter((d) => idSet.has(d)).length <= 1)
  if (isChain && steps.length > 2) {
    const ordered = steps.slice().sort((a, b) => (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0))
    const cols = Math.max(3, Math.ceil(Math.sqrt(ordered.length)))
    ordered.forEach((st, i) => {
      if (st.id in result) return
      const col = Math.floor(i / cols)
      const row = i % cols
      result[st.id] = avoidOverlap({ x: OFFSET_X + col * H_SPACING, y: OFFSET_Y + row * V_SPACING })
    })
    return result
  }

  for (let l = 0; l <= maxLayer; l++) {
    const ids = byLayer.get(l) ?? []
    const totalW = ids.length * H_SPACING
    const startX = OFFSET_X + Math.max(0, (totalW - H_SPACING) / 2)
    ids.forEach((id, i) => {
      if (!(id in result)) {
        result[id] = avoidOverlap({ x: startX + i * H_SPACING, y: OFFSET_Y + l * V_SPACING })
      }
    })
  }
  return result
}

function edgeBezier(x1: number, y1: number, x2: number, y2: number): string {
  const cy = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`
}

export function WorkflowCanvas({
  steps,
  editingStepId,
  onSelectStep,
  onDeselectStep,
  onAddStep,
  onDeleteStep,
  onContextMenu,
  onAddNodeRequest,
  onConnect,
  onEdgeContextMenu,
  onRenameStep,
  onSelectionChange,
  onDisconnectInputs,
  runningStepIds,
  inlineFields,
  onUpdateStepConfig,
  onUpdateStep,
  onOpenDrawer,
}: Props) {
  const [, forceRender] = useState(0)
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({})
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const viewportRef = useRef<HTMLDivElement>(null)
  const transformRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const activePan = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const activeDrag = useRef<{
    stepId: string
    startMouseX: number
    startMouseY: number
    group: { id: string; x: number; y: number }[]
  } | null>(null)
  const panXRef = useRef(0),
    panYRef = useRef(0),
    zoomRef = useRef(1)
  const [renderTick, setRenderTick] = useState(0)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const selectedIdsRef = useRef<Set<string>>(new Set())
  selectedIdsRef.current = selectedIds
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeRef = useRef<{ startX: number; startY: number } | null>(null)
  const spaceDownRef = useRef(false)
  const connectRef = useRef<{ fromId: string; path: SVGPathElement } | null>(null)
  const disconnectRef = useRef<{ toId: string; path: SVGPathElement } | null>(null)
  const stepsRef = useRef(steps)
  stepsRef.current = steps
  const onConnectRef = useRef(onConnect)
  onConnectRef.current = onConnect
  const onEdgeContextMenuRef = useRef(onEdgeContextMenu)
  onEdgeContextMenuRef.current = onEdgeContextMenu
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const onDeselectStepRef = useRef(onDeselectStep)
  onDeselectStepRef.current = onDeselectStep
  const onDisconnectInputsRef = useRef(onDisconnectInputs)
  onDisconnectInputsRef.current = onDisconnectInputs
  const onUpdateStepConfigRef = useRef(onUpdateStepConfig)
  onUpdateStepConfigRef.current = onUpdateStepConfig
  const onUpdateStepRef = useRef(onUpdateStep)
  onUpdateStepRef.current = onUpdateStep
  const onOpenDrawerRef = useRef(onOpenDrawer)
  onOpenDrawerRef.current = onOpenDrawer
  const edgesRef = useRef<EdgeEntry[]>([])
  const minimapRef = useRef<HTMLDivElement>(null)
  const minimapVpRef = useRef<SVGRectElement>(null)
  const minimapDragRef = useRef(false)
  const mmBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  if (steps.some((s) => !(s.id in positionsRef.current))) {
    const pos = dagLayout(steps, positionsRef.current)
    for (const [k, v] of Object.entries(pos)) positionsRef.current[k] = v
  }

  function reLayout() {
    const pos = dagLayout(steps, positionsRef.current, true)
    for (const [k, v] of Object.entries(pos)) positionsRef.current[k] = v
    setRenderTick((t) => t + 1)
    fitView()
  }

  function applyTransform() {
    if (transformRef.current)
      transformRef.current.style.transform = `translate(${panXRef.current}px, ${panYRef.current}px) scale(${zoomRef.current})`
  }

  function zoomBy(factor: number) {
    const vp = viewportRef.current
    if (!vp) return
    const cx = vp.clientWidth / 2
    const cy = vp.clientHeight / 2
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * factor))
    const ratio = newZoom / zoomRef.current
    panXRef.current = cx - ratio * (cx - panXRef.current)
    panYRef.current = cy - ratio * (cy - panYRef.current)
    zoomRef.current = newZoom
    applyTransform()
    renderEdges()
    updateMinimapViewport()
    setRenderTick((t) => t + 1)
  }

  function openNodePaletteFromEmpty() {
    const vp = viewportRef.current
    if (!vp) return
    const r = vp.getBoundingClientRect()
    onAddNodeRequest?.(r.left + r.width / 2, r.top + r.height / 2)
  }

  function commitRename() {
    if (renameId && renameValue.trim()) onRenameStep?.(renameId, renameValue.trim())
    setRenameId(null)
  }

  function fitView() {
    const vp = viewportRef.current
    if (!vp) return
    const pts = steps.map((st) => positionsRef.current[st.id]).filter(Boolean) as { x: number; y: number }[]
    if (pts.length === 0) return
    const minX = Math.min(...pts.map((pt) => pt.x))
    const maxX = Math.max(...pts.map((pt) => pt.x + NODE_W))
    const minY = Math.min(...pts.map((pt) => pt.y))
    const maxY = Math.max(...pts.map((pt) => pt.y + NODE_H))
    const vw = vp.clientWidth
    const vh = vp.clientHeight
    if (vw === 0 || vh === 0) return
    const gw = maxX - minX
    const gh = maxY - minY
    const z = Math.min(vw / (gw + 96), vh / (gh + 96), FIT_MAX_ZOOM)
    zoomRef.current = Math.max(MIN_ZOOM, z)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    panXRef.current = vw / 2 - cx * zoomRef.current
    panYRef.current = vh / 2 - cy * zoomRef.current
    applyTransform()
    renderEdges()
    updateMinimapViewport()
  }

  function renderEdges() {
    const svg = svgRef.current
    const vp = viewportRef.current
    if (!svg || !vp) return
    const vr = vp.getBoundingClientRect()
    for (const e of edgesRef.current) {
      const from = portScreen(e.fromId, 'out', vr)
      const to = portScreen(e.toId, 'in', vr)
      if (!from || !to) continue
      const d = edgeBezier(from.x, from.y, to.x, to.y)
      svg.querySelectorAll(`[data-edge-idx="${e.idx}"]`).forEach((p) => p.setAttribute('d', d))
      svg.querySelectorAll(`[data-edge-hit-idx="${e.idx}"]`).forEach((p) => p.setAttribute('d', d))
      if (e.conditionLabel) {
        const lbl = svg.querySelector(`[data-edge-label-idx="${e.idx}"]`)
        if (lbl) {
          lbl.setAttribute('x', String((from.x + to.x) / 2))
          lbl.setAttribute('y', String((from.y + to.y) / 2 - 10))
        }
      }
    }
  }

  function updateMinimapViewport() {
    const rect = minimapVpRef.current
    const vp = viewportRef.current
    if (!rect || !vp) return
    rect.setAttribute('x', String(-panXRef.current / zoomRef.current))
    rect.setAttribute('y', String(-panYRef.current / zoomRef.current))
    rect.setAttribute('width', String(vp.clientWidth / zoomRef.current))
    rect.setAttribute('height', String(vp.clientHeight / zoomRef.current))
  }

  function jumpMinimap(clientX: number, clientY: number) {
    const mm = minimapRef.current
    const vp = viewportRef.current
    const box = mmBoxRef.current
    if (!mm || !vp || !box) return
    const r = mm.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const wx = box.x + ((clientX - r.left) / r.width) * box.w
    const wy = box.y + ((clientY - r.top) / r.height) * box.h
    panXRef.current = vp.clientWidth / 2 - wx * zoomRef.current
    panYRef.current = vp.clientHeight / 2 - wy * zoomRef.current
    applyTransform()
    renderEdges()
    updateMinimapViewport()
  }

  function portScreen(stepId: string, side: 'in' | 'out', vr: DOMRect): { x: number; y: number } | null {
    const nodeEl = nodeRefs.current[stepId]
    const portEl = nodeEl?.querySelector(side === 'in' ? '.wf-canvas-port-input' : '.wf-canvas-port-output')
    if (portEl) {
      const r = portEl.getBoundingClientRect()
      return { x: r.x + r.width / 2 - vr.left, y: r.y + r.height / 2 - vr.top }
    }
    const p = positionsRef.current[stepId]
    if (!p) return null
    const wx = side === 'in' ? p.x : p.x + NODE_W
    return { x: wx * zoomRef.current + panXRef.current, y: (p.y + PORT_OFFSET) * zoomRef.current + panYRef.current }
  }

  function inlineConfigValue(step: StepDef, path: string[]): any {
    let val: any = step.config || {}
    for (const k of path) {
      if (val === undefined || val === null) return ''
      val = val[k]
    }
    return val ?? ''
  }

  function setInlineConfig(stepId: string, path: string[], value: any) {
    const current: any = steps.find((st) => st.id === stepId)?.config || {}
    const newConfig: Record<string, any> = { ...current }
    let target = newConfig
    for (let i = 0; i < path.length - 1; i++) {
      if (!target[path[i]] || typeof target[path[i]] !== 'object') target[path[i]] = {}
      target = target[path[i]]
    }
    target[path[path.length - 1]] = value
    onUpdateStepConfigRef.current?.(stepId, newConfig)
  }

  function updateConnectPath(clientX: number, clientY: number) {
    const c = connectRef.current
    const vp = viewportRef.current
    if (!c || !vp) return
    const vr = vp.getBoundingClientRect()
    const from = portScreen(c.fromId, 'out', vr)
    const x2 = clientX - vr.left
    const y2 = clientY - vr.top
    if (!from) return
    c.path.setAttribute('d', edgeBezier(from.x, from.y, x2, y2))
  }

  function updateDisconnectPath(clientX: number, clientY: number) {
    const c = disconnectRef.current
    const vp = viewportRef.current
    if (!c || !vp) return
    const vr = vp.getBoundingClientRect()
    const to = portScreen(c.toId, 'in', vr)
    const x2 = clientX - vr.left
    const y2 = clientY - vr.top
    if (!to) return
    c.path.setAttribute('d', edgeBezier(x2, y2, to.x, to.y))
  }

  function hitInputPort(clientX: number, clientY: number): { nodeEl: HTMLElement } | null {
    const probes = [
      [0, 0],
      [-9, 0],
      [9, 0],
      [0, -9],
      [0, 9],
      [-7, -7],
      [7, 7],
      [-7, 7],
      [7, -7],
    ]
    for (const [ox, oy] of probes) {
      const el = document.elementFromPoint(clientX + ox, clientY + oy) as HTMLElement | null
      const port = el?.closest?.('.wf-canvas-port-input')
      const nodeEl = el?.closest?.('.wf-canvas-node') as HTMLElement | null
      if (port && nodeEl) return { nodeEl }
    }
    return null
  }

  const didFitRef = useRef(false)
  useEffect(() => {
    if (didFitRef.current) return
    if (steps.length === 0) return
    const raf = requestAnimationFrame(() => {
      fitView()
      didFitRef.current = true
      revealEditingNode()
    })
    return () => cancelAnimationFrame(raf)
  }, [steps])

  function revealEditingNode() {
    if (!editingStepId) return
    const el = nodeRefs.current[editingStepId]
    const vp = viewportRef.current
    if (!el || !vp) return
    const er = el.getBoundingClientRect()
    const vr = vp.getBoundingClientRect()
    const margin = 56
    const needsX = er.left < vr.left + margin || er.right > vr.right - margin
    const needsY = er.top < vr.top + margin || er.bottom > vr.bottom - margin
    if (!needsX && !needsY) return
    const dx = needsX ? er.left - vr.left - (vr.width - er.width) / 2 : 0
    const dy = needsY ? er.top - vr.top - (vr.height - er.height) / 2 : 0
    panXRef.current -= dx
    panYRef.current -= dy
    applyTransform()
    renderEdges()
    updateMinimapViewport()
  }

  useEffect(() => {
    revealEditingNode()
  }, [editingStepId])

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (activeDrag.current) {
        const d = activeDrag.current
        const dx = (e.clientX - d.startMouseX) / zoomRef.current,
          dy = (e.clientY - d.startMouseY) / zoomRef.current
        for (const g of d.group) {
          positionsRef.current[g.id] = { x: Math.round(g.x + dx), y: Math.round(g.y + dy) }
          const el = nodeRefs.current[g.id]
          if (el) {
            el.style.left = `${positionsRef.current[g.id].x}px`
            el.style.top = `${positionsRef.current[g.id].y}px`
          }
        }
        renderEdges()
      } else if (activePan.current) {
        panXRef.current = activePan.current.panX + (e.clientX - activePan.current.startX)
        panYRef.current = activePan.current.panY + (e.clientY - activePan.current.startY)
        applyTransform()
        renderEdges()
        updateMinimapViewport()
      } else if (marqueeRef.current) {
        const vp = viewportRef.current
        if (!vp) return
        const vr = vp.getBoundingClientRect()
        const sx = marqueeRef.current.startX,
          sy = marqueeRef.current.startY
        const cx = e.clientX - vr.left,
          cy = e.clientY - vr.top
        setMarquee({ x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) })
      } else if (disconnectRef.current) {
        updateDisconnectPath(e.clientX, e.clientY)
      } else if (connectRef.current) {
        updateConnectPath(e.clientX, e.clientY)
      } else if (minimapDragRef.current) {
        jumpMinimap(e.clientX, e.clientY)
      }
    }
    function onMouseUp(e: MouseEvent) {
      minimapDragRef.current = false
      if (disconnectRef.current) {
        const c = disconnectRef.current
        disconnectRef.current = null
        c.path.remove()
        viewportRef.current?.classList.remove('connecting')
        const hit = hitInputPort(e.clientX, e.clientY)
        if (!hit) onDisconnectInputsRef.current?.(c.toId)
        return
      }
      if (connectRef.current) {
        const c = connectRef.current
        connectRef.current = null
        c.path.remove()
        viewportRef.current?.classList.remove('connecting')
        const hit = hitInputPort(e.clientX, e.clientY)
        const toId = hit?.nodeEl.getAttribute('data-step-id') ?? undefined
        if (hit && toId && toId !== c.fromId) onConnectRef.current?.(c.fromId, toId)
        return
      }
      if (activeDrag.current) {
        activeDrag.current = null
        setRenderTick((t) => t + 1)
      }
      if (marqueeRef.current) {
        const m = marqueeRef.current
        marqueeRef.current = null
        const vp = viewportRef.current
        if (vp) {
          const vr = vp.getBoundingClientRect()
          const ex = e.clientX - vr.left,
            ey = e.clientY - vr.top
          const bx = Math.min(m.startX, ex),
            by = Math.min(m.startY, ey),
            bw = Math.abs(ex - m.startX),
            bh = Math.abs(ey - m.startY)
          if (bw > 4 || bh > 4) {
            const rect = {
              x: (bx - panXRef.current) / zoomRef.current,
              y: (by - panYRef.current) / zoomRef.current,
              w: bw / zoomRef.current,
              h: bh / zoomRef.current,
            }
            const hit = stepsRef.current
              .filter((st) => {
                const p = positionsRef.current[st.id]
                if (!p) return false
                return p.x < rect.x + rect.w && p.x + NODE_W > rect.x && p.y < rect.y + rect.h && p.y + NODE_H > rect.y
              })
              .map((st) => st.id)
            if (hit.length > 0) {
              setSelectedIds(new Set(hit))
              onSelectionChangeRef.current?.(hit)
            }
          }
        }
        setMarquee(null)
      }
      activePan.current = null
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space') {
        e.preventDefault()
        spaceDownRef.current = true
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') spaceDownRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    // 用箭头函数而不是函数声明：函数声明会被提升，TS 认为它捕获的 el 收窄状态
    // 取自作用域入口（即 if (!el) return 之前），因此内部仍把 el 当作可能为 null。
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect(),
        mouseX = e.clientX - rect.left,
        mouseY = e.clientY - rect.top
      const delta = -e.deltaY * 0.001
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current + delta * zoomRef.current))
      const ratio = newZoom / zoomRef.current
      panXRef.current = mouseX - ratio * (mouseX - panXRef.current)
      panYRef.current = mouseY - ratio * (mouseY - panYRef.current)
      zoomRef.current = newZoom
      applyTransform()
      renderEdges()
      updateMinimapViewport()
      setRenderTick((t) => t + 1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useLayoutEffect(() => {
    renderEdges()
    updateMinimapViewport()
  })

  const edges = useMemo<EdgeEntry[]>(() => {
    const result: EdgeEntry[] = []
    let i = 0
    for (const step of steps) {
      for (const dep of step.dependsOn) {
        result.push({
          id: `${step.id}->${dep}`,
          idx: i,
          fromId: dep,
          toId: step.id,
          failure: step.runOn === 'failure',
          running: runningStepIds?.has(step.id) ?? false,
        })
        i++
      }
      const cond = (step as any).config?.condition?.cases as { if?: string; goto?: string }[] | undefined
      if (step.handler === 'condition' && cond) {
        for (const c of cond) {
          result.push({
            id: `cond-${step.id}->${c.goto}`,
            idx: i,
            fromId: step.id,
            toId: c.goto ?? '',
            failure: false,
            running: false,
            conditionLabel: c.if,
          })
          i++
        }
      }
    }
    return result
  }, [steps, renderTick, runningStepIds])
  edgesRef.current = edges

  const mmBounds = useMemo(() => {
    const pts = steps.map((st) => positionsRef.current[st.id]).filter(Boolean) as { x: number; y: number }[]
    if (pts.length === 0) return null
    const pad = 28
    const minX = Math.min(...pts.map((pt) => pt.x)) - pad
    const minY = Math.min(...pts.map((pt) => pt.y)) - pad
    const maxX = Math.max(...pts.map((pt) => pt.x + NODE_W)) + pad
    const maxY = Math.max(...pts.map((pt) => pt.y + NODE_H)) + pad
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }, [steps, renderTick])
  if (mmBounds) mmBoxRef.current = mmBounds

  function renderInlineField(step: StepDef, field: FieldDef) {
    const path = configPathFor(field.key)
    const val = inlineConfigValue(step, path)
    const stop = (e: React.SyntheticEvent) => {
      e.stopPropagation()
    }
    const onOpenMore = () => {
      onOpenDrawerRef.current?.()
    }
    const setVal = (v: any) => {
      if (path.length > 1) setInlineConfig(step.id, path, v)
      else onUpdateStepConfigRef.current?.(step.id, { [field.key]: v })
    }
    const fieldId = `wf-inline-${step.id}-${field.key}`
    switch (field.type) {
      case 'textarea': {
        return (
          <div key={field.key} className="wf-canvas-inline-field">
            <label htmlFor={fieldId}>{field.label}</label>
            <textarea
              id={fieldId}
              rows={Math.min(field.rows ?? 3, 3)}
              value={typeof val === 'string' ? val : ''}
              placeholder={field.placeholder}
              onChange={(e) => setVal(e.target.value)}
              onMouseDown={stop}
            />
          </div>
        )
      }
      case 'text': {
        return (
          <div key={field.key} className="wf-canvas-inline-field">
            <label htmlFor={fieldId}>{field.label}</label>
            <input
              id={fieldId}
              type="text"
              value={typeof val === 'string' ? val : ''}
              placeholder={field.placeholder}
              onChange={(e) => setVal(e.target.value)}
              onMouseDown={stop}
            />
          </div>
        )
      }
      case 'number': {
        return (
          <div key={field.key} className="wf-canvas-inline-field">
            <label htmlFor={fieldId}>{field.label}</label>
            <input
              id={fieldId}
              type="number"
              value={val === '' || val == null ? '' : String(val)}
              placeholder={field.placeholder}
              onChange={(e) => setVal(e.target.value ? Number(e.target.value) : undefined)}
              onMouseDown={stop}
            />
          </div>
        )
      }
      case 'radio': {
        const current = path.length > 1 ? val : (step.runOn ?? 'success')
        return (
          <div key={field.key} className="wf-canvas-inline-field">
            <label>{field.label}</label>
            <div className="wf-canvas-inline-seg">
              {(field.options ?? []).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={current === opt.value ? 'active' : ''}
                  onMouseDown={stop}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (path.length > 1) setInlineConfig(step.id, path, opt.value)
                    else onUpdateStepRef.current?.(step.id, { runOn: opt.value as 'success' | 'failure' })
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )
      }
      case 'multi-select': {
        const tools = (step.config.allowedTools ?? []) as string[]
        const count = Array.isArray(tools) ? tools.length : 0
        return (
          <div key={field.key} className="wf-canvas-inline-field">
            <label>{field.label}</label>
            <button
              type="button"
              className="wf-canvas-inline-summary"
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation()
                onOpenMore()
              }}
            >
              <span>{count > 0 ? `已选 ${count} 个工具` : '未选择（默认全部）'}</span>
              <i className="ri-settings-3-line" />
            </button>
          </div>
        )
      }
      default: {
        const ftype = (field as any).type
        if (ftype === 'multi-select-steps') {
          const sources: string[] = Array.isArray(val) ? val : []
          return (
            <div key={field.key} className="wf-canvas-inline-field">
              <label>{field.label}</label>
              <button
                type="button"
                className="wf-canvas-inline-summary"
                onMouseDown={stop}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenMore()
                }}
              >
                <span>{sources.length > 0 ? `已选 ${sources.length} 个来源` : '未选择源'}</span>
                <i className="ri-settings-3-line" />
              </button>
            </div>
          )
        }
        const summary = val === '' || val == null ? '在更多参数中编辑' : typeof val === 'string' ? val.slice(0, 24) : '已设置'
        return (
          <div key={field.key} className="wf-canvas-inline-field">
            <label>{field.label}</label>
            <button
              type="button"
              className="wf-canvas-inline-summary"
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation()
                onOpenMore()
              }}
            >
              <span>{summary}</span>
              <i className="ri-settings-3-line" />
            </button>
          </div>
        )
      }
    }
  }

  return (
    <div className="wf-canvas-panel">
      <div className="wf-canvas-toolbar">
        <button className="wf-canvas-tb-btn" onClick={reLayout} title="自动排版">
          <i className="ri-grid-line" />
        </button>
        <span className="wf-canvas-tb-divider" />
        <button className="wf-canvas-tb-btn" onClick={() => zoomBy(1 / 1.25)} title="缩小">
          <i className="ri-zoom-out-line" />
        </button>
        <span className="wf-canvas-zoom-label">{Math.round(zoomRef.current * 100)}%</span>
        <button className="wf-canvas-tb-btn" onClick={() => zoomBy(1.25)} title="放大">
          <i className="ri-zoom-in-line" />
        </button>
        <span className="wf-canvas-tb-divider" />
        <button
          className="wf-canvas-tb-btn"
          onClick={() => {
            zoomRef.current = 1
            panXRef.current = 0
            panYRef.current = 0
            applyTransform()
            renderEdges()
            setRenderTick((t) => t + 1)
          }}
          title="重置视图"
        >
          <i className="ri-fullscreen-line" />
        </button>
      </div>
      <div
        className="wf-canvas-viewport"
        ref={viewportRef}
        onMouseDown={(e) => {
          if (e.button !== 0 && e.button !== 1) return
          const target = e.target as HTMLElement
          if (target.closest('.wf-canvas-node') || target.closest('.wf-canvas-add-btn') || target.closest('.wf-minimap')) return
          if (e.button === 1 || spaceDownRef.current || e.shiftKey) {
            e.preventDefault()
            activePan.current = { startX: e.clientX, startY: e.clientY, panX: panXRef.current, panY: panYRef.current }
            return
          }
          const vr = viewportRef.current?.getBoundingClientRect()
          if (!vr) return
          marqueeRef.current = { startX: e.clientX - vr.left, startY: e.clientY - vr.top }
          setMarquee({ x: e.clientX - vr.left, y: e.clientY - vr.top, w: 0, h: 0 })
          setSelectedIds(new Set())
          onSelectionChangeRef.current?.([])
          onDeselectStepRef.current?.()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu(e.clientX, e.clientY, null)
        }}
        onDoubleClick={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('.wf-canvas-node')) return
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          onAddNodeRequest?.(e.clientX - rect.left, e.clientY - rect.top)
        }}
      >
        <svg className="wf-canvas-edges" ref={svgRef}>
          {edges.map((edge) => (
            <g key={edge.id}>
              <path
                data-edge-hit-idx={edge.idx}
                d=""
                className="wf-canvas-edge-hit"
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onEdgeContextMenuRef.current?.(e.clientX, e.clientY, edge.fromId, edge.toId)
                }}
              />
              <path
                data-edge-idx={edge.idx}
                d=""
                className={`wf-canvas-edge${edge.failure ? ' wf-canvas-edge-failure' : ''}${edge.conditionLabel ? ' wf-canvas-edge-condition' : ''}${edge.running ? ' wf-canvas-edge-running' : ''}`}
              />
            </g>
          ))}
          {edges
            .filter((e) => e.conditionLabel)
            .map((edge) => (
              <text key={`lbl-${edge.id}`} data-edge-label-idx={edge.idx} x={0} y={0} className="wf-canvas-edge-label" textAnchor="middle">
                {edge.conditionLabel}
              </text>
            ))}
        </svg>
        {steps.length === 0 && (
          <div className="wf-canvas-empty">
            <div className="wf-canvas-empty-icon">
              <i className="ri-node-tree" />
            </div>
            <div className="wf-canvas-empty-title">空白画布</div>
            <div className="wf-canvas-empty-desc">从节点库挑选节点，拖拽端口即可连线编排</div>
            <div className="wf-canvas-empty-actions">
              <button className="wf-canvas-empty-btn wf-canvas-empty-btn-primary" onClick={openNodePaletteFromEmpty}>
                <i className="ri-add-circle-line" /> 添加节点
              </button>
              <button className="wf-canvas-empty-btn" onClick={onAddStep}>
                <i className="ri-flashlight-line" /> 快速步骤
              </button>
            </div>
          </div>
        )}
        <div className="wf-canvas-transform" ref={transformRef}>
          <div className="wf-canvas-grid" aria-hidden="true" />
          {steps.map((step) => {
            const pos = positionsRef.current[step.id]
            if (!pos) return null
            const icon = HANDLER_ICONS[step.handler] ?? 'ri-circle-line'
            const label = HANDLER_LABELS[step.handler] ?? step.handler
            const accent = HANDLER_COLORS[step.handler] ?? 'var(--accent)'
            const isRunning = runningStepIds?.has(step.id)
            const isInlineOpen = editingStepId === step.id && (inlineFields ?? []).length > 0
            const configSummary =
              step.handler === 'tool'
                ? step.config?.tool
                : step.handler === 'api'
                  ? step.config?.apiUrl
                  : step.handler === 'prompt'
                    ? (step.config?.prompt ?? '').slice(0, 30)
                    : step.handler === 'gate'
                      ? '需人工审批'
                      : step.handler === 'foreach'
                        ? `循环 ${(step.config as any)?.foreach?.items ?? ''}`
                        : ''
            return (
              <div
                key={step.id}
                ref={(el) => {
                  nodeRefs.current[step.id] = el
                }}
                data-step-id={step.id}
                className={`wf-canvas-node${editingStepId === step.id ? ' selected' : ''}${isRunning ? ' running' : ''}${
                  selectedIds.has(step.id) ? ' multi-selected' : ''
                }${isInlineOpen ? ' inline-open' : ''}`}
                style={{ left: pos.x, top: pos.y, width: isInlineOpen ? NODE_W_INLINE : NODE_W }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return
                  const p = positionsRef.current[step.id]
                  if (!p) return
                  const inGroup = selectedIdsRef.current.has(step.id)
                  if (!inGroup) {
                    setSelectedIds(new Set([step.id]))
                    onSelectionChangeRef.current?.([step.id])
                  }
                  const group = inGroup
                    ? [...selectedIdsRef.current].map((id) => {
                        const gp = positionsRef.current[id]
                        return { id, x: gp?.x ?? 0, y: gp?.y ?? 0 }
                      })
                    : [{ id: step.id, x: p.x, y: p.y }]
                  activeDrag.current = { stepId: step.id, startMouseX: e.clientX, startMouseY: e.clientY, group }
                }}
                onClick={() => onSelectStep(step.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenu(e.clientX, e.clientY, step.id)
                }}
              >
                <div className="wf-canvas-node-header" style={{ '--node-accent': accent } as React.CSSProperties}>
                  <div className="wf-canvas-node-status-dot" data-running={isRunning} />
                  <i className={icon} />
                  {renameId === step.id ? (
                    <input
                      className="wf-canvas-node-rename"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setRenameId(null)
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="wf-canvas-node-name"
                      title="双击重命名"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        setRenameId(step.id)
                        setRenameValue(step.name || '')
                      }}
                    >
                      {step.name || '未命名'}
                    </span>
                  )}
                  <span className="wf-canvas-node-type">{label}</span>
                  {isRunning && <span className="wf-canvas-node-running-badge">运行中</span>}
                </div>
                <div className="wf-canvas-node-body">
                  {configSummary && <span className="wf-canvas-node-config-hint">{configSummary}</span>}
                  <div className="wf-canvas-node-io">
                    <div className="wf-canvas-io-row wf-canvas-io-in">
                      <span
                        className="wf-canvas-port wf-canvas-port-input"
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          e.stopPropagation()
                          e.preventDefault()
                          const hasIn = edgesRef.current.some((ed) => ed.toId === step.id)
                          if (!hasIn) return
                          const vp = viewportRef.current
                          const svg = svgRef.current
                          if (!vp || !svg) return
                          vp.classList.add('connecting')
                          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
                          path.setAttribute('class', 'wf-canvas-edge wf-canvas-edge-draft wf-canvas-edge-disconnect')
                          svg.appendChild(path)
                          disconnectRef.current = { toId: step.id, path }
                          updateDisconnectPath(e.clientX, e.clientY)
                        }}
                      />
                      <span className="wf-canvas-io-label">输入</span>
                    </div>
                    <div className="wf-canvas-io-row wf-canvas-io-out">
                      <span className="wf-canvas-io-label">输出</span>
                      <span
                        className="wf-canvas-port wf-canvas-port-output"
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          e.stopPropagation()
                          e.preventDefault()
                          const vp = viewportRef.current
                          const svg = svgRef.current
                          if (!vp || !svg) return
                          vp.classList.add('connecting')
                          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
                          path.setAttribute('class', 'wf-canvas-edge wf-canvas-edge-draft')
                          svg.appendChild(path)
                          connectRef.current = { fromId: step.id, path }
                          updateConnectPath(e.clientX, e.clientY)
                        }}
                      />
                    </div>
                  </div>
                </div>
                {isInlineOpen && (
                  <div className="wf-canvas-node-inline" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="wf-canvas-node-inline-head">
                      <span>参数</span>
                      <button
                        type="button"
                        className="wf-canvas-node-inline-more"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenDrawerRef.current?.()
                        }}
                      >
                        <i className="ri-settings-3-line" />
                        更多参数
                      </button>
                    </div>
                    {(inlineFields ?? []).map((field) => renderInlineField(step, field))}
                  </div>
                )}
                <button
                  className="wf-canvas-node-del"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteStep(step.id)
                  }}
                >
                  <i className="ri-close-line" />
                </button>
              </div>
            )
          })}
        </div>
        {steps.length > 0 && (
          <button className="wf-canvas-add-btn" onClick={onAddStep}>
            <i className="ri-add-line" /> 添加步骤
          </button>
        )}
        {marquee && <div className="wf-canvas-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        <div className="wf-canvas-statusbar">
          <span>
            <i className="ri-node-tree" /> {steps.length} 节点
          </span>
          <span className="wf-canvas-statusbar-divider" />
          <span>
            <i className="ri-link" /> {edges.length} 连线
          </span>
          <span className="wf-canvas-statusbar-divider" />
          <span>
            <i className="ri-zoom-in-line" /> {Math.round(zoomRef.current * 100)}%
          </span>
        </div>
      </div>
      {mmBounds && steps.length > 0 && (
        <div
          className="wf-minimap"
          ref={minimapRef}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            minimapDragRef.current = true
            jumpMinimap(e.clientX, e.clientY)
          }}
        >
          <svg
            viewBox={`${mmBounds.x} ${mmBounds.y} ${mmBounds.w} ${mmBounds.h}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="workflow minimap"
          >
            {edges.map((edge) => {
              const from = positionsRef.current[edge.fromId]
              const to = positionsRef.current[edge.toId]
              if (!from || !to) return null
              return (
                <line
                  key={`mm-${edge.id}`}
                  x1={from.x + NODE_W}
                  y1={from.y + PORT_OFFSET}
                  x2={to.x}
                  y2={to.y + PORT_OFFSET}
                  className="wf-minimap-edge"
                />
              )
            })}
            {steps.map((step) => {
              const pos = positionsRef.current[step.id]
              if (!pos) return null
              const accent = HANDLER_COLORS[step.handler] ?? 'var(--accent)'
              return (
                <rect
                  key={`mmn-${step.id}`}
                  x={pos.x}
                  y={pos.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={4}
                  className="wf-minimap-node"
                  style={{ fill: accent }}
                />
              )
            })}
            <rect ref={minimapVpRef} className="wf-minimap-vp" />
          </svg>
        </div>
      )}
    </div>
  )
}
