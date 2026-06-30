import { useState, useRef, useMemo, useEffect } from 'react'
import type { StepDef } from './WorkflowEditor'

interface Props {
  steps: StepDef[]
  editingStepId: string | null
  onSelectStep: (id: string) => void
  onAddStep: () => void
  onDeleteStep: (id: string) => void
  onDuplicateStep: (id: string) => void
  onContextMenu: (x: number, y: number, stepId: string | null) => void
}

const HANDLER_ICONS: Record<string, string> = {
  subagent: 'ri-robot-2-line',
  prompt: 'ri-question-mark',
  tool: 'ri-tools-line',
  api: 'ri-api-line',
  plan: 'ri-file-list-3-line',
}
const HANDLER_LABELS: Record<string, string> = { subagent: '子 Agent', prompt: 'Prompt', tool: 'Tool', api: 'API', plan: 'Plan' }
const HANDLER_COLORS: Record<string, string> = {
  subagent: 'oklch(0.65 0.18 240)',
  prompt: 'oklch(0.65 0.12 80)',
  tool: 'oklch(0.55 0.14 160)',
  api: 'oklch(0.55 0.16 300)',
  plan: 'oklch(0.55 0.12 30)',
}

const NODE_W = 180
const NODE_H = 64
const LAYOUT_COLS = 4
const H_SPACING = 220
const V_SPACING = 140
const OFFSET_X = 48
const OFFSET_Y = 40
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2

/** Assign each step a "layer" based on dependency depth, then layout by layer.
 *  Layer 0 = roots (no deps), Layer 1 = depend on layer 0, etc.
 *  Nodes that already have positions keep them unless always flag is set. */
function dagLayout(
  steps: StepDef[],
  preExisting: Record<string, { x: number; y: number }>,
  always = false,
): Record<string, { x: number; y: number }> {
  if (steps.length === 0) return {}

  // compute layers
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

  // group by layer
  const byLayer = new Map<number, string[]>()
  let maxLayer = 0
  for (const s of steps) {
    const l = layer.get(s.id)!
    if (l > maxLayer) maxLayer = l
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(s.id)
  }

  const result: Record<string, { x: number; y: number }> = {}
  // preserve pre-existing positions unless `always` overrides
  if (!always) for (const [k, v] of Object.entries(preExisting)) result[k] = v

  for (let l = 0; l <= maxLayer; l++) {
    const ids = byLayer.get(l) ?? []
    const totalW = ids.length * H_SPACING
    const startX = OFFSET_X + Math.max(0, (totalW - H_SPACING) / 2) // roughly center
    ids.forEach((id, i) => {
      if (!(id in result)) {
        result[id] = { x: startX + i * H_SPACING, y: OFFSET_Y + l * V_SPACING }
      }
    })
  }
  return result
}

function ensurePositions(steps: StepDef[], ref: Record<string, { x: number; y: number }>, force = false) {
  const pos = dagLayout(steps, ref, force)
  for (const [k, v] of Object.entries(pos)) ref[k] = v
}

/**
 * Bezier from canvas-space coords → viewport-space by applying pan+zoom.
 * x1,y1 = output port (bottom-center of source), x2,y2 = input port (top-center of target)
 */
function viewportBezier(x1: number, y1: number, x2: number, y2: number, px: number, py: number, z: number): string {
  const vx1 = x1 * z + px
  const vy1 = y1 * z + py
  const vx2 = x2 * z + px
  const vy2 = y2 * z + py
  const cy = (vy1 + vy2) / 2
  return `M ${vx1} ${vy1} C ${vx1} ${cy}, ${vx2} ${cy}, ${vx2} ${vy2}`
}

export function WorkflowCanvas({ steps, editingStepId, onSelectStep, onAddStep, onDeleteStep, onContextMenu }: Props) {
  const [, forceRender] = useState(0)
  const [positionVersion, setPositionVersion] = useState(0)

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
    startNodeX: number
    startNodeY: number
  } | null>(null)

  // pan/zoom stored in refs for 60fps direct-DOM updates
  const panXRef = useRef(0)
  const panYRef = useRef(0)
  const zoomRef = useRef(1)

  // re-render key so SVG paths update via useMemo
  const [renderTick, setRenderTick] = useState(0)

  // ensure every step has a position before first paint
  if (steps.some((s) => !(s.id in positionsRef.current))) {
    ensurePositions(steps, positionsRef.current)
  }

  // force full DAG relayout
  function reLayout() {
    ensurePositions(steps, positionsRef.current, true)
    setPositionVersion((v) => v + 1)
    setRenderTick((t) => t + 1)
  }
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (activeDrag.current) {
        const d = activeDrag.current
        const dx = (e.clientX - d.startMouseX) / zoomRef.current
        const dy = (e.clientY - d.startMouseY) / zoomRef.current
        positionsRef.current[d.stepId] = { x: Math.round(d.startNodeX + dx), y: Math.round(d.startNodeY + dy) }
        const el = nodeRefs.current[d.stepId]
        if (el) {
          el.style.left = `${positionsRef.current[d.stepId].x}px`
          el.style.top = `${positionsRef.current[d.stepId].y}px`
        }
        // update SVG during drag
        renderEdges()
      } else if (activePan.current) {
        panXRef.current = activePan.current.panX + (e.clientX - activePan.current.startX)
        panYRef.current = activePan.current.panY + (e.clientY - activePan.current.startY)
        applyTransform()
        renderEdges()
      }
    }
    function onMouseUp() {
      if (activeDrag.current) {
        activeDrag.current = null
        setPositionVersion((v) => v + 1)
        setRenderTick((t) => t + 1)
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

  function applyTransform() {
    if (transformRef.current) {
      transformRef.current.style.transform = `translate(${panXRef.current}px, ${panYRef.current}px) scale(${zoomRef.current})`
    }
  }

  // ── wheel zoom (native listener for passive:false) ──
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const delta = -e.deltaY * 0.001
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current + delta * zoomRef.current))
      const ratio = newZoom / zoomRef.current
      panXRef.current = mouseX - ratio * (mouseX - panXRef.current)
      panYRef.current = mouseY - ratio * (mouseY - panYRef.current)
      zoomRef.current = newZoom
      applyTransform()
      renderEdges()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── raw SVG edge render (called during drag/pan for 60fps) ──
  function renderEdges() {
    const svg = svgRef.current
    if (!svg) return
    const px = panXRef.current
    const py = panYRef.current
    const z = zoomRef.current
    let i = 0
    for (const step of steps) {
      for (const depId of step.dependsOn) {
        const from = positionsRef.current[depId]
        const to = positionsRef.current[step.id]
        if (!from || !to) continue
        const path = svg.querySelector(`[data-edge-idx="${i}"]`)
        if (path) {
          path.setAttribute('d', viewportBezier(from.x + NODE_W / 2, from.y + NODE_H, to.x + NODE_W / 2, to.y, px, py, z))
        }
        i++
      }
    }
  }

  // ── edge descriptors for initial render ──
  const edges = useMemo(() => {
    const result: { id: string; idx: number; d: string; failure: boolean }[] = []
    let i = 0
    for (const step of steps) {
      for (const depId of step.dependsOn) {
        const from = positionsRef.current[depId]
        const to = positionsRef.current[step.id]
        if (!from || !to) continue
        result.push({
          id: `${step.id}->${depId}`,
          idx: i,
          d: viewportBezier(
            from.x + NODE_W / 2,
            from.y + NODE_H,
            to.x + NODE_W / 2,
            to.y,
            panXRef.current,
            panYRef.current,
            zoomRef.current,
          ),
          failure: step.runOn === 'failure',
        })
        i++
      }
    }
    return result
  }, [steps, positionVersion, renderTick])

  const PORT_SIZE = 10

  return (
    <div className="wf-editor-canvas-panel">
      <div
        className="wf-canvas-viewport"
        ref={viewportRef}
        onMouseDown={handleViewportMouseDown}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu(e.clientX, e.clientY, null)
        }}
      >
        {/* SVG overlay at viewport level — fills viewport, coords in viewport space */}
        <svg
          className="wf-canvas-edges"
          ref={svgRef}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
        >
          {edges.map((edge) => (
            <path
              key={edge.id}
              data-edge-idx={edge.idx}
              d={edge.d}
              className={`wf-canvas-edge${edge.failure ? ' wf-canvas-edge-failure' : ''}`}
            />
          ))}
        </svg>

        {/* Transform layer — only for nodes */}
        <div className="wf-canvas-transform" ref={transformRef} style={{ position: 'absolute', top: 0, left: 0, zIndex: 2 }}>
          {steps.map((step) => {
            const pos = positionsRef.current[step.id]
            if (!pos) return null
            const icon = HANDLER_ICONS[step.handler] ?? 'ri-circle-line'
            const label = HANDLER_LABELS[step.handler] ?? step.handler
            const accent = HANDLER_COLORS[step.handler] ?? 'var(--accent)'
            return (
              <div
                key={step.id}
                ref={(el) => {
                  nodeRefs.current[step.id] = el
                }}
                className={`wf-canvas-node${editingStepId === step.id ? ' selected' : ''}`}
                style={{ left: pos.x, top: pos.y, width: NODE_W, position: 'absolute' }}
                data-selected={editingStepId === step.id}
                onMouseDown={(e) => startNodeDrag(step.id, e)}
                onClick={() => onSelectStep(step.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenu(e.clientX, e.clientY, step.id)
                }}
              >
                <div className="wf-canvas-port wf-canvas-port-input" style={{ marginLeft: -PORT_SIZE / 2 }} />
                <div className="wf-canvas-node-header" style={{ '--node-accent': accent } as React.CSSProperties}>
                  <i className={icon} style={{ color: accent }} />
                  <span>{step.name || '未命名步骤'}</span>
                </div>
                <div className="wf-canvas-node-body">
                  <span className="wf-canvas-node-handler-label">{label}</span>
                  {step.dependsOn.length > 0 && <span className="wf-canvas-node-dep-count">{step.dependsOn.length} dep</span>}
                  {step.runOn === 'failure' && <span className="wf-canvas-node-condition-failure">on failure</span>}
                </div>
                <div className="wf-canvas-port wf-canvas-port-output" style={{ marginLeft: -PORT_SIZE / 2 }} />
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

        <button className="wf-canvas-add-btn" onClick={onAddStep} style={{ position: 'absolute', zIndex: 10 }}>
          <i className="ri-add-line" /> 添加步骤
        </button>
        <button className="wf-canvas-layout-btn" onClick={reLayout} style={{ position: 'absolute', zIndex: 10 }}>
          <i className="ri-grid-line" /> 重新排版
        </button>
      </div>
    </div>
  )

  function handleViewportMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.wf-canvas-node') || target.closest('.wf-canvas-add-btn')) return
    activePan.current = { startX: e.clientX, startY: e.clientY, panX: panXRef.current, panY: panYRef.current }
  }

  function startNodeDrag(stepId: string, e: React.MouseEvent) {
    e.stopPropagation()
    const pos = positionsRef.current[stepId]
    if (!pos) return
    activeDrag.current = { stepId, startMouseX: e.clientX, startMouseY: e.clientY, startNodeX: pos.x, startNodeY: pos.y }
  }
}
