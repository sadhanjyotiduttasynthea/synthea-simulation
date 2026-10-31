import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

export interface MeshInfo { nx: number; ny: number; h_mm: number; x0_mm: number; y0_mm: number; depth_mm: number; cells: number; mask: string }

/** Perceptual colour maps (sampled stops, linear interpolation). */
const MAPS: Record<string, string[]> = {
  thermal: ['#000004', '#320a5e', '#781b6c', '#bb3754', '#ec6824', '#fbb41a', '#fcffa4'],
  viridis: ['#440154', '#3b528b', '#21908d', '#5dc963', '#fde725'],
  stress: ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'],
  diverging: ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b'],
}
const cache: Record<string, THREE.Color[]> = {}
export function colorAt(map: string, t: number, out = new THREE.Color()) {
  const stops = (cache[map] ??= (MAPS[map] ?? MAPS.viridis).map((c) => new THREE.Color(c)))
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1)
  const i = Math.min(Math.floor(x), stops.length - 2)
  return out.copy(stops[i]).lerp(stops[i + 1], x - i)
}
export function gradientCss(map: string) {
  return `linear-gradient(to top, ${(MAPS[map] ?? MAPS.viridis).join(', ')})`
}

/** Cell centres (mm) in mask order, centred on the grid. */
export function cellCentres(m: MeshInfo) {
  const xs: number[] = []
  const ys: number[] = []
  const cx = m.x0_mm + (m.nx * m.h_mm) / 2
  const cy = m.y0_mm + (m.ny * m.h_mm) / 2
  for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) if (m.mask[j * m.nx + i] === '1') {
    xs.push(m.x0_mm + (i + 0.5) * m.h_mm - cx)
    ys.push(m.y0_mm + (j + 0.5) * m.h_mm - cy)
  }
  return { xs, ys }
}

/**
 * The 2-D cross-section extruded along z (depth): one instanced box per cell, coloured by a
 * cell field. Fields are uniform along z (2-D model assumption). Optional in-plane displacement
 * (structural) is applied with a scale factor. The section lies in the x-y plane, centred at the origin.
 */
export function TwinField({ mesh, values, range, map = 'viridis', color = '#c9a46c', disp, dispScale = 0, depthScale = 1, mask, onReady, cellColors }: {
  mesh: MeshInfo; values?: (number | null)[] | null; range?: [number, number]; map?: string; color?: string
  disp?: { ux: (number | null)[]; uy: (number | null)[] } | null; dispScale?: number; depthScale?: number; mask?: number[] | null; onReady?: () => void; cellColors?: (string | null)[] | null
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const { xs, ys } = useMemo(() => cellCentres(mesh), [mesh])
  const depth = mesh.depth_mm * depthScale
  useLayoutEffect(() => {
    const im = ref.current
    if (!im) return
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    const base = new THREE.Color(color)
    const [lo, hi] = range ?? [0, 1]
    const span = hi - lo || 1
    for (let k = 0; k < xs.length; k++) {
      const dx = disp ? (disp.ux[k] ?? 0) * 1000 * dispScale : 0
      const dy = disp ? (disp.uy[k] ?? 0) * 1000 * dispScale : 0
      m.makeTranslation(xs[k] + dx, ys[k] + dy, 0)
      im.setMatrixAt(k, m)
      if (cellColors) {
        im.setColorAt(k, cellColors[k] ? c.set(cellColors[k]!) : base)
      } else if (values) {
        const v = values[k]
        colorAt(map, v == null ? 0 : (v - lo) / span, c)
        if (mask && mask[k]) c.lerp(new THREE.Color('#ffffff'), 0.55)
        im.setColorAt(k, c)
      } else im.setColorAt(k, base)
    }
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    if (!im.userData.colorReady) {
      // the shader must be recompiled once the per-instance colour attribute exists
      ;(im.material as THREE.Material).needsUpdate = true
      im.userData.colorReady = true
    }
    im.computeBoundingBox()
    im.computeBoundingSphere()
    onReady?.()
  }, [xs, ys, values, range, map, color, disp, dispScale, mask, cellColors])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <instancedMesh key={xs.length} ref={ref} args={[undefined, undefined, xs.length]}>
      <boxGeometry args={[mesh.h_mm, mesh.h_mm, depth]} />
      <meshStandardMaterial roughness={0.65} metalness={0.02} />
    </instancedMesh>
  )
}

/** Mesh edges drawn on the front face (z = depth/2) plus the back outline. */
export function TwinMeshLines({ mesh, depthScale = 1, color = '#0891b2' }: { mesh: MeshInfo; depthScale?: number; color?: string }) {
  const geo = useMemo(() => {
    const { xs, ys } = cellCentres(mesh)
    const h = mesh.h_mm / 2
    const z = (mesh.depth_mm * depthScale) / 2 + 0.05
    const pts: number[] = []
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k]
      const y = ys[k]
      pts.push(x - h, y - h, z, x + h, y - h, z, x + h, y - h, z, x + h, y + h, z, x + h, y + h, z, x - h, y + h, z, x - h, y + h, z, x - h, y - h, z)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [mesh, depthScale])
  return (
    <lineSegments geometry={geo} userData={{ noViewMode: true }}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  )
}

export function Legend({ title, unit, range, map }: { title: string; unit: string; range: [number, number]; map: string }) {
  const fmt = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(2) : v.toPrecision(4))
  return (
    <div className="flex items-stretch gap-1.5 rounded bg-black/60 p-1.5 text-[10px] text-white">
      <div className="w-3 rounded-sm" style={{ background: gradientCss(map), minHeight: 110 }} />
      <div className="flex flex-col justify-between">
        <span>{fmt(range[1])}</span>
        <span className="max-w-28 font-semibold">{title}{unit ? ` [${unit}]` : ''}</span>
        <span>{fmt(range[0])}</span>
      </div>
    </div>
  )
}

export const SEGMENT_COLORS = ['#e11d48', '#0891b2', '#16a34a', '#f59e0b', '#7c3aed', '#db2777', '#0d9488', '#ea580c', '#2563eb', '#65a30d', '#9333ea', '#ca8a04']
