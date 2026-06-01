import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { readMicEnergy, readTTSEnergy } from './audioShared'

function hash(x: number, y: number) {
  const h = (x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}

function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  return hash(ix, iy) * (1 - ux) * (1 - uy)
    + hash(ix + 1, iy) * ux * (1 - uy)
    + hash(ix, iy + 1) * (1 - ux) * uy
    + hash(ix + 1, iy + 1) * ux * uy
}

export function WaveRibbon({ ttsPlaying }: { ttsPlaying?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const ttsRef = useRef(false)
  useEffect(() => { ttsRef.current = !!ttsPlaying }, [ttsPlaying])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

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

    const NSEG = 300, NUM = 60
    const GW = NSEG + 1, GH = NUM
    const Hf = new Float32Array(GW * GH)
    const Hold = new Float32Array(GW * GH)
    const DAMP = 0.995

    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const h = (noise(i * 0.03 + 17.3, j * 0.12 + 5.7) - 0.5) * 0.4
        Hf[j * GW + i] = h
        Hold[j * GW + i] = h
      }
    }

    function ribbonColor(row: number) {
      const t = row / (NUM - 1)
      return [0.3 + t * 0.25, 0.12 + t * 0.5, 0.55 + t * 0.35]
    }

    const RIB_DEFS: { idx: number; row: number; yOff: number; zOff: number; amp: number; scale: number; opacity: number }[] = []
    for (let n = 0; n < NUM; n++) {
      RIB_DEFS.push({
        idx: n, row: n, yOff: (n - 30) * 0.006, zOff: -n * 0.10,
        amp: 2.2, scale: 2.2, opacity: 0.28 + Math.random() * 0.35,
      })
    }

    const lines: THREE.LineSegments[] = []

    function buildLine(rib: typeof RIB_DEFS[0]) {
      const nv = NSEG + 1
      const pos = new Float32Array(nv * 3)
      const col = new Float32Array(nv * 3)
      const idx: number[] = []

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
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]
      }

      for (let i = 0; i < NSEG; i++) idx.push(i, i + 1)

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      geo.setIndex(idx)

      const mat = new THREE.LineBasicMaterial({
        vertexColors: true, linewidth: 1,
        transparent: true, opacity: rib.opacity,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })

      const line = new THREE.LineSegments(geo, mat)
      ;(line as any).rib = rib
      return line
    }

    for (const def of RIB_DEFS) {
      const l = buildLine(def)
      lines.push(l)
      scene.add(l)
    }

    function updateWaveField() {
      const nH = new Float32Array(GW * GH)
      for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
          const iL = i > 0 ? i - 1 : i
          const iR = i < GW - 1 ? i + 1 : i
          const jT = j > 0 ? j - 1 : j
          const jB = j < GH - 1 ? j + 1 : j
          const idx = j * GW + i
          const avg = (Hf[j * GW + iL] + Hf[j * GW + iR] + Hf[jT * GW + i] + Hf[jB * GW + i]) * 0.25
          nH[idx] = (avg * 2 - Hold[idx]) * DAMP
        }
      }
      Hold.set(Hf)
      Hf.set(nH)
    }

    function updateAll() {
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
        l.material.opacity = rib.opacity
      }
    }

    let energy = 0
    let idleTimer = 0

    const ampBuf = new Float32Array(GW * GH)

    function perturb() {
      const T = clock.getElapsedTime()
      const dt = 1 / 60
      const micEn = readMicEnergy()
      const ttsEn = readTTSEnergy()
      const combined = Math.max(micEn, ttsEn)
      energy = energy * 0.6 + combined * 0.4

      if (ttsRef.current && ttsEn < 0.02) {
        const fake = 0.15 + Math.sin(T * 8) * 0.1 + Math.random() * 0.1
        energy = Math.max(energy, fake)
      }

      ampBuf.fill(0)

      // 定时随机涟漪 — 等于水滴
      idleTimer += dt
      if (idleTimer > 1.0 + Math.random() * 2.0) {
        const ci = Math.floor(10 + Math.random() * (GW - 20))
        const cj = Math.floor(5 + Math.random() * (NUM - 10))
        const strength = (1.2 + Math.random() * 1.8) * (Math.random() > 0.5 ? 1 : -1)
        const R = 5 + Math.floor(Math.random() * 4)
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            const ii = ci + di, jj = cj + dj
            if (ii < 0 || ii >= GW || jj < 0 || jj >= GH) continue
            const dist = Math.sqrt(di * di + dj * dj)
            if (dist > R) continue
            ampBuf[jj * GW + ii] += strength * (1 - dist / R) * 0.15
          }
        }
        idleTimer = 0
      }

      // 音频驱动大幅抖动
      if (energy > 0.01) {
        const spots = 1 + Math.floor(energy * 20)
        for (let s = 0; s < spots; s++) {
          const ci = Math.floor(Math.random() * GW)
          const cj = Math.floor(5 + Math.random() * (NUM - 10))
          const strength = 0.15 + energy * 0.25
          const sign = Math.random() > 0.5 ? 1 : -1
          const R = 4 + Math.floor(energy * 8)
          for (let dj = -R; dj <= R; dj++) {
            for (let di = -R; di <= R; di++) {
              const ii = ci + di, jj = cj + dj
              if (ii < 0 || ii >= GW || jj < 0 || jj >= GH) continue
              const dist = Math.sqrt(di * di + dj * dj)
              if (dist > R) continue
              ampBuf[jj * GW + ii] += sign * strength * (1 - dist / R) * 0.1
            }
          }
        }
      }

      for (let i = 0; i < GW * GH; i++) Hf[i] += ampBuf[i]
    }

    const PN = 60
    const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3)
    const pBase: [number, number, number][] = []
    const pSpd: number[] = []
    const pPh: number[] = []

    for (let k = 0; k < PN; k++) {
      pBase.push([(Math.random() - 0.5) * 40, (Math.random() - 0.5) * 14, -2 + (Math.random() - 0.5) * 14])
      pSpd.push(0.005 + Math.random() * 0.035)
      pPh.push(Math.random() * Math.PI * 2)
      pPos[k * 3] = pBase[k][0]
      pPos[k * 3 + 1] = pBase[k][1]
      pPos[k * 3 + 2] = pBase[k][2]
      const pc = ribbonColor(Math.floor(Math.random() * NUM))
      pCol[k * 3] = pc[0]; pCol[k * 3 + 1] = pc[1]; pCol[k * 3 + 2] = pc[2]
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

    const particleSystem = new THREE.Points(pg, new THREE.PointsMaterial({
      size: 1.2, map: new THREE.CanvasTexture(cv), vertexColors: true,
      sizeAttenuation: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    scene.add(particleSystem)

    const clock = new THREE.Clock()
    let rafId: number | null = null

    function tick() {
      const T = clock.getElapsedTime()

      updateWaveField()
      perturb()
      updateAll()

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

    function onResize() {
      const w = container.clientWidth
      const h = container.clientHeight
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
      if (particleSystem.material) {
        const pm = particleSystem.material as THREE.PointsMaterial
        if (pm.map) pm.map.dispose()
        pm.dispose()
      }
      for (const line of lines) {
        scene.remove(line)
        line.geometry.dispose()
        ;(line.material as THREE.Material).dispose()
      }
      renderer.dispose()
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={containerRef} className="wave-ribbon" />
}
