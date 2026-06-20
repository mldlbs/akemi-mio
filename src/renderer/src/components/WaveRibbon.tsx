import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { readMicEnergy, readTTSEnergy } from './audioShared'

function hash(x: number, y: number) {
  const h = (x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}

function noise(x: number, y: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y)
  const fx = x - ix,
    fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  return (
    hash(ix, iy) * (1 - ux) * (1 - uy) +
    hash(ix + 1, iy) * ux * (1 - uy) +
    hash(ix, iy + 1) * (1 - ux) * uy +
    hash(ix + 1, iy + 1) * ux * uy
  )
}

export function WaveRibbon({ ttsPlaying }: { ttsPlaying?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const ttsRef = useRef(false)
  useEffect(() => {
    ttsRef.current = !!ttsPlaying
  }, [ttsPlaying])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // ---- 1. Three.js 场景初始化 ----
    const W = container.clientWidth || 220
    const H = container.clientHeight || 220
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setSize(W, H)
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 500)
    camera.position.set(0, 0, 28)
    camera.lookAt(0, 0, 0)

    // ---- 2. 波动场初始化 ----
    const NSEG = 300,
      NUM = 60
    const GW = NSEG + 1,
      GH = NUM
    const DAMP = 0.995
    const Hf = new Float32Array(GW * GH)
    const Hold = new Float32Array(GW * GH)
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const h = (noise(i * 0.03 + 17.3, j * 0.12 + 5.7) - 0.5) * 0.4
        Hf[j * GW + i] = h
        Hold[j * GW + i] = h
      }
    }

    // ---- 3. 彩带定义与构建 ----
    function ribbonColor(row: number) {
      const t = row / (NUM - 1)
      const r = 0.3 + t * 0.35
      const g = 0.08 + t * 0.18
      const b = 0.04 + t * 0.1
      return [r, g, b]
    }

    const RIB_DEFS = Array.from({ length: NUM }, (_, n) => ({
      idx: n,
      row: n,
      yOff: (n - 30) * 0.006,
      zOff: -n * 0.1,
      amp: 2.2,
      scale: 2.2,
      opacity: 0.28 + Math.random() * 0.35,
    }))

    function buildLine(rib: (typeof RIB_DEFS)[0]) {
      const nv = NSEG + 1
      const pos = new Float32Array(nv * 3)
      const col = new Float32Array(nv * 3)
      for (let i = 0; i <= NSEG; i++) {
        const u = i / NSEG
        const h = Hf[rib.row * GW + i] * rib.amp
        const raw = Math.sin(u * Math.PI)
        const env = raw * raw * (3 - 2 * raw)
        const zScale = 1 - rib.zOff * 0.07
        pos[i * 3] = (u - 0.5) * 28 * zScale
        pos[i * 3 + 1] = rib.yOff + h * env * rib.scale
        pos[i * 3 + 2] = rib.zOff
        const c = ribbonColor(rib.row)
        col[i * 3] = c[0]
        col[i * 3 + 1] = c[1]
        col[i * 3 + 2] = c[2]
      }
      const idx = Array.from({ length: NSEG }, (_, i) => [i, i + 1]).flat()
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      geo.setIndex(idx)
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        linewidth: 1,
        transparent: true,
        opacity: rib.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const line = new THREE.LineSegments(geo, mat)
      ;(line as any).rib = rib
      return line
    }

    const lines = RIB_DEFS.map((def) => {
      const l = buildLine(def)
      scene.add(l)
      return l
    })

    // ---- 4. 粒子系统 ----
    const PN = 60
    const pBase: [number, number, number][] = []
    const pSpd: number[] = []
    const pPh: number[] = []
    for (let k = 0; k < PN; k++) {
      pBase.push([(Math.random() - 0.5) * 40, (Math.random() - 0.5) * 14, -2 + (Math.random() - 0.5) * 14])
      pSpd.push(0.005 + Math.random() * 0.035)
      pPh.push(Math.random() * Math.PI * 2)
    }
    const pPos = new Float32Array(PN * 3),
      pCol = new Float32Array(PN * 3)
    for (let k = 0; k < PN; k++) {
      pPos[k * 3] = pBase[k][0]
      pPos[k * 3 + 1] = pBase[k][1]
      pPos[k * 3 + 2] = pBase[k][2]
      const pc = ribbonColor(Math.floor(Math.random() * NUM))
      pCol[k * 3] = pc[0]
      pCol[k * 3 + 1] = pc[1]
      pCol[k * 3 + 2] = pc[2]
    }
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    pg.setAttribute('color', new THREE.BufferAttribute(pCol, 3))
    const cv = document.createElement('canvas')
    cv.width = cv.height = 64
    const cx = cv.getContext('2d')!
    const gr = cx.createRadialGradient(32, 32, 0, 32, 32, 32)
    gr.addColorStop(0, 'rgba(255,255,255,1)')
    gr.addColorStop(0.08, 'rgba(255,255,255,0.8)')
    gr.addColorStop(0.3, 'rgba(255,255,255,0.18)')
    gr.addColorStop(0.6, 'rgba(255,255,255,0.02)')
    gr.addColorStop(1, 'rgba(255,255,255,0)')
    cx.fillStyle = gr
    cx.fillRect(0, 0, 64, 64)
    const particleSystem = new THREE.Points(
      pg,
      new THREE.PointsMaterial({
        size: 1.2,
        map: new THREE.CanvasTexture(cv),
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    scene.add(particleSystem)

    // ---- 5. 物理更新函数 ----
    function updateWaveField() {
      const nH = new Float32Array(GW * GH)
      for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
          const iL = i > 0 ? i - 1 : i
          const iR = i < GW - 1 ? i + 1 : i
          const jT = j > 0 ? j - 1 : j
          const jB = j < GH - 1 ? j + 1 : j
          const avg = (Hf[j * GW + iL] + Hf[j * GW + iR] + Hf[jT * GW + i] + Hf[jB * GW + i]) * 0.25
          nH[j * GW + i] = (avg * 2 - Hold[j * GW + i]) * DAMP
        }
      }
      Hold.set(Hf)
      Hf.set(nH)
    }

    function updateRibbons() {
      for (const l of lines) {
        const rib = (l as any).rib
        const pos = l.geometry.attributes.position.array as Float32Array
        for (let i = 0; i <= NSEG; i++) {
          const u = i / NSEG
          const h = Hf[rib.row * GW + i] * rib.amp
          const raw = Math.sin(u * Math.PI)
          const env = raw * raw * (3 - 2 * raw)
          const zScale = 1 - rib.zOff * 0.07
          pos[i * 3] = (u - 0.5) * 28 * zScale
          pos[i * 3 + 1] = rib.yOff + h * env * rib.scale
          pos[i * 3 + 2] = rib.zOff
        }
        l.geometry.attributes.position.needsUpdate = true
      }
    }

    let energy = 0
    let idleTimer = 0
    const ampBuf = new Float32Array(GW * GH)

    function perturbWithAudio() {
      const T = clock.getElapsedTime()
      const dt = 1 / 60
      const micEn = readMicEnergy()
      const ttsEn = readTTSEnergy()
      const combined = Math.max(micEn, ttsEn)
      energy = energy * 0.6 + combined * 0.4

      if (ttsRef.current && ttsEn < 0.02) {
        energy = Math.max(energy, 0.15 + Math.sin(T * 8) * 0.1 + Math.random() * 0.1)
      }

      ampBuf.fill(0)
      idleTimer += dt
      if (idleTimer > 1.0 + Math.random() * 2.0) {
        addRipple(ampBuf, GW, NUM, idleTimer)
        idleTimer = 0
      }
      if (energy > 0.01) {
        for (let s = 1 + Math.floor(energy * 20); s > 0; s--) addRipple(ampBuf, GW, NUM, 0, energy)
      }
      for (let i = 0; i < GW * GH; i++) Hf[i] += ampBuf[i]
    }

    // ---- 6. 动画循环 ----
    const clock = new THREE.Clock()
    let rafId: number | null = null

    function tick() {
      const T = clock.getElapsedTime()
      updateWaveField()
      perturbWithAudio()
      updateRibbons()

      const pa = pg.attributes.position.array as Float32Array
      for (let k = 0; k < PN; k++) {
        pa[k * 3] = pBase[k][0] + Math.sin(T * pSpd[k] * 2 + pPh[k]) * 1.5
        pa[k * 3 + 1] = pBase[k][1] + Math.cos(T * pSpd[k] * 1.3 + pPh[k]) * 0.9
        pa[k * 3 + 2] = pBase[k][2] + Math.sin(T * pSpd[k] * 0.7 + pPh[k]) * 0.6
      }
      pg.attributes.position.needsUpdate = true

      camera.position.set(0, 0, 28)
      camera.lookAt(0, 0, 0)
      renderer.render(scene, camera)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    const onResize = () => {
      const w = container.clientWidth,
        h = container.clientHeight
      if (w > 0 && h > 0) {
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h)
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      scene.remove(particleSystem)
      pg.dispose()
      const pm = particleSystem.material as THREE.PointsMaterial
      if (pm.map) pm.map.dispose()
      pm.dispose()
      for (const line of lines) {
        scene.remove(line)
        line.geometry.dispose()
        ;(line.material as THREE.Material).dispose()
      }
      renderer.dispose()
      if (renderer.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={containerRef} className="wave-ribbon" />
}

function addRipple(ampBuf: Float32Array, GW: number, NUM: number, idleTimer: number, energy = 0) {
  const ci = Math.floor(10 + Math.random() * (GW - 20))
  const cj = Math.floor(5 + Math.random() * (NUM - 10))
  const isIdle = idleTimer > 0
  const strength = isIdle
    ? (1.2 + Math.random() * 1.8) * (Math.random() > 0.5 ? 1 : -1)
    : (0.15 + energy * 0.25) * (Math.random() > 0.5 ? 1 : -1)
  const R = isIdle ? 5 + Math.floor(Math.random() * 4) : 4 + Math.floor(energy * 8)
  const scale = isIdle ? 0.15 : 0.1
  for (let dj = -R; dj <= R; dj++) {
    for (let di = -R; di <= R; di++) {
      const ii = ci + di,
        jj = cj + dj
      if (ii < 0 || ii >= GW || jj < 0 || jj >= NUM) continue
      const dist = Math.sqrt(di * di + dj * dj)
      if (dist > R) continue
      ampBuf[jj * GW + ii] += strength * (1 - dist / R) * scale
    }
  }
}
