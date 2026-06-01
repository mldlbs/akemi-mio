import { useRef, useEffect } from 'react'
import * as THREE from 'three'

interface Props { active?: boolean; size?: number }

export function Waveform({ active, size = 340 }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50)
    camera.position.set(0, 0, 6.5)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(size, size)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)

    // ─── 主粒子系统 (800 个粒子围绕球面) ───
    const particleCount = 800
    const pPos = new Float32Array(particleCount * 3)
    const pBase = new Float32Array(particleCount) // 基础半径
    const pAngles = new Float32Array(particleCount) // 角度
    const pPhases = new Float32Array(particleCount) // 相位偏移

    for (let i = 0; i < particleCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 1.2 + Math.random() * 2.8
      pBase[i] = r
      pAngles[i] = theta
      pPhases[i] = Math.random() * Math.PI * 2
      pPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pPos[i * 3 + 1] = r * Math.cos(phi) * 0.5
      pPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const pGeo = new THREE.BufferGeometry()
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    const pMat = new THREE.PointsMaterial({
      color: 0x60a5fa,
      size: 0.025,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const particles = new THREE.Points(pGeo, pMat)
    scene.add(particles)

    // ─── 波形线条 (5 圈同心波形环) ───
    const waveLines: THREE.Line[] = []
    for (let ring = 0; ring < 5; ring++) {
      const segments = 120
      const pts: THREE.Vector3[] = []
      const radius = 1.6 + ring * 0.45
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2
        pts.push(new THREE.Vector3(
          Math.cos(angle) * radius,
          0,
          Math.sin(angle) * radius
        ))
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color().setHSL(0.58 + ring * 0.025, 0.7, 0.4 + ring * 0.08),
        transparent: true,
        opacity: 0.12 + ring * 0.04,
      })
      const line = new THREE.Line(geo, mat)
      scene.add(line)
      waveLines.push(line)
    }

    // ─── 垂直光柱环 (32 根) ───
    const glowBars: THREE.Mesh[] = []
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2
      const gGeo = new THREE.PlaneGeometry(0.04, 0.6)
      const gMat = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        transparent: true,
        opacity: 0.04,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const g = new THREE.Mesh(gGeo, gMat)
      g.position.set(Math.cos(angle) * 3.8, 0, Math.sin(angle) * 3.8)
      g.lookAt(0, 0, 0)
      scene.add(g)
      glowBars.push(g)
    }

    // ─── 中心发光体 ───
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x93c5fd })
    )
    scene.add(core)
    const glowRing = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.25, 48),
      new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    scene.add(glowRing)

    // ─── 存储粒子位置引用 ───
    const posAttr = pGeo.attributes.position as THREE.BufferAttribute
    const posArray = posAttr.array as Float32Array

    let raf: number
    const animate = () => {
      const t = performance.now() * 0.001
      const intensity = active ? 1.0 : 0.2
      const speed = active ? 2.5 : 0.6

      // 更新粒子位置（沿径向脉动 + 波浪）
      for (let i = 0; i < particleCount; i++) {
        const wave = Math.sin(t * speed + pPhases[i]) * 0.35 * intensity
        const wave2 = Math.sin(t * speed * 1.7 + pAngles[i] * 3) * 0.2 * intensity
        const r = pBase[i] + wave + wave2
        const theta = pAngles[i] + t * 0.03 * intensity * (i % 2 === 0 ? 1 : -1)
        const phi = Math.PI / 2 + Math.sin(t * 0.2 + pPhases[i]) * 0.2
        posArray[i * 3] = r * Math.sin(phi) * Math.cos(theta)
        posArray[i * 3 + 1] = (r * Math.cos(phi)) * 0.4
        posArray[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
      }
      posAttr.needsUpdate = true
      pMat.opacity = 0.15 + 0.35 * intensity
      pMat.size = 0.015 + 0.02 * intensity

      // 波形环（Z 轴波纹）
      for (let ring = 0; ring < waveLines.length; ring++) {
        const positions = (waveLines[ring].geometry as THREE.BufferGeometry).attributes.position
        const arr = positions.array as Float32Array
        const radius = 1.6 + ring * 0.45
        for (let i = 0; i <= 120; i++) {
          const angle = (i / 120) * Math.PI * 2
          const waveH = Math.sin(angle * 4 + t * speed + ring * 0.5) * 0.15 * intensity
            + Math.sin(angle * 8 + t * speed * 1.8) * 0.06 * intensity
          arr[i * 3 + 1] = waveH
          arr[i * 3] = Math.cos(angle) * (radius + waveH * 0.1)
          arr[i * 3 + 2] = Math.sin(angle) * (radius + waveH * 0.1)
        }
        positions.needsUpdate = true
        waveLines[ring].material.opacity = 0.06 + ring * 0.03 + 0.05 * intensity
      }

      // 光柱闪烁
      for (let i = 0; i < glowBars.length; i++) {
        ;(glowBars[i].material as THREE.MeshBasicMaterial).opacity =
          0.02 + Math.sin(t * speed + i * 0.4) * 0.035 * intensity
      }

      // 中心体
      core.scale.setScalar(1 + Math.sin(t * speed) * 0.12 * intensity)
      glowRing.scale.setScalar(0.8 + Math.sin(t * speed + 1) * 0.15 * intensity)
      glowRing.material.opacity = 0.08 + 0.1 * intensity

      // 整体缓慢旋转
      scene.rotation.y += 0.002 * intensity
      scene.rotation.x = Math.sin(t * 0.1) * 0.04

      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      renderer.dispose()
      scene.traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
          o.geometry?.dispose()
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose())
          else o.material?.dispose()
        }
      })
      el.removeChild(renderer.domElement)
    }
  }, [active, size])

  return (
    <div
      ref={mountRef}
      style={{ width: size, height: size, filter: 'drop-shadow(0 0 40px rgba(96,165,250,0.25))' }}
    />
  )
}
