import { GizmoHelper, GizmoViewport, Html, Line, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { Axis3d, Box, Eye, Grid3x3, Maximize, Ruler, Scissors, Square } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitImpl } from 'three-stdlib'
import { cx } from './ui'
import { useStore } from '../store'

export type ViewMode = 'solid' | 'wireframe' | 'transparent'
export type CameraPreset = 'iso' | 'top' | 'front' | 'right'

interface ViewState {
  mode: ViewMode
  section: number | null // clipping plane position along X (scene units), null = off
  measuring: boolean
}
const ViewCtx = createContext<ViewState>({ mode: 'solid', section: null, measuring: false })
export const useViewState = () => useContext(ViewCtx)

/** Applies wireframe / transparency / clipping to every mesh below `root` whenever settings change. */
function MaterialModes({ root, mode, section }: { root: React.RefObject<THREE.Group | null>; mode: ViewMode; section: number | null }) {
  const { gl, invalidate } = useThree()
  useEffect(() => {
    gl.localClippingEnabled = true
    const planes = section === null ? [] : [new THREE.Plane(new THREE.Vector3(-1, 0, 0), section)]
    root.current?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!m || (o as THREE.Mesh).userData.noViewMode) return
      for (const mat of Array.isArray(m) ? m : [m]) {
        const mm = mat as THREE.MeshStandardMaterial
        if ('wireframe' in mm) mm.wireframe = mode === 'wireframe'
        mm.transparent = mode === 'transparent' || mm.userData.baseTransparent === true
        mm.opacity = mode === 'transparent' ? 0.35 : (mm.userData.baseOpacity ?? 1)
        mm.depthWrite = mode !== 'transparent'
        mm.clippingPlanes = planes
        mm.clipShadows = true
        mm.side = section === null ? (mm.userData.baseSide ?? THREE.FrontSide) : THREE.DoubleSide
        mm.needsUpdate = true
      }
    })
    invalidate()
  })
  return null
}

function CameraRig({ preset, fitToken, root, ortho, controls }: { preset: CameraPreset; fitToken: number; root: React.RefObject<THREE.Group | null>; ortho: boolean; controls: React.RefObject<OrbitImpl | null> }) {
  const { camera, size } = useThree()
  useEffect(() => {
    const box = new THREE.Box3()
    if (root.current) box.setFromObject(root.current)
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50))
    const c = box.getCenter(new THREE.Vector3())
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)
    const dir = { iso: new THREE.Vector3(1, 0.8, 1.1), top: new THREE.Vector3(0, 1, 0.0001), front: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0) }[ortho ? 'top' : preset].normalize()
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const fov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180
      camera.position.copy(c).addScaledVector(dir, (r / Math.sin(fov / 2)) * 1.1)
      camera.near = r / 100
      camera.far = r * 100
    } else {
      const oc = camera as THREE.OrthographicCamera
      camera.position.copy(c).addScaledVector(dir, r * 4)
      oc.zoom = Math.min(size.width, size.height) / (2.4 * r)
      oc.near = -r * 50
      oc.far = r * 50
    }
    camera.lookAt(c)
    camera.updateProjectionMatrix()
    if (controls.current) {
      controls.current.target.copy(c)
      controls.current.update()
    }
  }, [preset, fitToken, ortho])  // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function Measure({ points }: { points: THREE.Vector3[] }) {
  if (points.length === 0) return null
  const d = points.length === 2 ? points[0].distanceTo(points[1]) : null
  return (
    <group>
      {points.map((p, i) => (
        <mesh key={i} position={p} userData={{ noViewMode: true }}>
          <sphereGeometry args={[0.8, 12, 12]} />
          <meshBasicMaterial color="#06b6d4" />
        </mesh>
      ))}
      {points.length === 2 && (
        <>
          <Line points={points} color="#06b6d4" lineWidth={2} />
          <Html position={points[0].clone().lerp(points[1], 0.5)} center>
            <div className="whitespace-nowrap rounded bg-cyan-600 px-1.5 py-0.5 text-[11px] font-semibold text-white shadow">{d!.toFixed(2)} mm</div>
          </Html>
        </>
      )}
    </group>
  )
}

export interface GraphicsViewProps {
  children: ReactNode
  dimension?: '2d' | '3d'
  toolbar?: ReactNode
  overlay?: ReactNode
  gridSize?: number
  onBackgroundClick?: () => void
  className?: string
  initialPreset?: CameraPreset
  fitSignal?: number
  showGizmo?: boolean
  legend?: ReactNode
}

/**
 * Engineering graphics window: perspective/orthographic camera, orbit/pan/zoom,
 * camera presets, fit-to-view, grid and axes, view modes, section plane and a
 * two-point measurement tool. Scene units are millimetres.
 */
export function GraphicsView({ children, dimension = '3d', toolbar, overlay, gridSize = 200, onBackgroundClick, className, initialPreset = 'iso', fitSignal = 0, showGizmo = true, legend }: GraphicsViewProps) {
  const dark = useStore((s) => s.dark)
  const [mode, setMode] = useState<ViewMode>('solid')
  const [preset, setPreset] = useState<CameraPreset>(initialPreset)
  const [fit, setFit] = useState(0)
  const [grid, setGrid] = useState(true)
  const [axes, setAxes] = useState(true)
  const [section, setSection] = useState<number | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [pts, setPts] = useState<THREE.Vector3[]>([])
  const root = useRef<THREE.Group>(null)
  const controls = useRef<OrbitImpl>(null)
  const ortho = dimension === '2d'
  useEffect(() => setFit((f) => f + 1), [fitSignal])
  useEffect(() => { const t = setTimeout(() => setFit((f) => f + 1), 300); return () => clearTimeout(t) }, [])

  const onPick = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!measuring) return
    e.stopPropagation()
    setPts((p) => (p.length >= 2 ? [e.point.clone()] : [...p, e.point.clone()]))
  }, [measuring])

  const state = useMemo(() => ({ mode, section, measuring }), [mode, section, measuring])
  const btn = (active: boolean) => cx('flex h-6 items-center gap-1 rounded px-1.5 text-[11px]', active ? 'bg-rose-600 text-white' : 'text-neutral-300 hover:bg-white/10')

  return (
    <div className={cx('relative flex h-full min-h-[320px] flex-col overflow-hidden rounded border border-neutral-300 dark:border-white/10', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 bg-[#1d2026] px-1.5 py-1">
        {!ortho && (['iso', 'top', 'front', 'right'] as CameraPreset[]).map((p) => <button key={p} className={btn(preset === p)} onClick={() => { setPreset(p); setFit((f) => f + 1) }}>{p === 'iso' ? 'Iso' : p[0].toUpperCase() + p.slice(1)}</button>)}
        <button className={btn(false)} onClick={() => setFit((f) => f + 1)} title="Zoom to fit"><Maximize className="h-3.5 w-3.5" />Fit</button>
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button className={btn(mode === 'solid')} onClick={() => setMode('solid')}><Box className="h-3.5 w-3.5" />Solid</button>
        <button className={btn(mode === 'wireframe')} onClick={() => setMode('wireframe')}><Grid3x3 className="h-3.5 w-3.5" />Wire</button>
        <button className={btn(mode === 'transparent')} onClick={() => setMode('transparent')}><Eye className="h-3.5 w-3.5" />Transparent</button>
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button className={btn(grid)} onClick={() => setGrid(!grid)}><Square className="h-3.5 w-3.5" />Grid</button>
        <button className={btn(axes)} onClick={() => setAxes(!axes)}><Axis3d className="h-3.5 w-3.5" />Axes</button>
        {!ortho && <button className={btn(section !== null)} onClick={() => setSection(section === null ? 0 : null)}><Scissors className="h-3.5 w-3.5" />Section</button>}
        {section !== null && <input type="range" min={-gridSize / 2} max={gridSize / 2} step={0.5} value={section} onChange={(e) => setSection(Number(e.target.value))} className="w-28" aria-label="Section position" />}
        <button className={btn(measuring)} onClick={() => { setMeasuring(!measuring); setPts([]) }}><Ruler className="h-3.5 w-3.5" />Measure</button>
        <div className="flex-1" />
        {toolbar}
      </div>
      <div className="relative min-h-0 flex-1">
        <Canvas
          frameloop="always"
          dpr={[1, 2]}
          gl={{ antialias: true, preserveDrawingBuffer: true }}
          onPointerMissed={() => onBackgroundClick?.()}
          style={{ background: dark ? 'linear-gradient(#1a1d22, #0c0d10)' : 'linear-gradient(#f7f8fa, #dfe3e8)' }}
        >
          {ortho ? <OrthographicCamera makeDefault position={[0, 300, 0]} zoom={3} /> : <PerspectiveCamera makeDefault fov={35} position={[180, 140, 200]} />}
          <ambientLight intensity={0.55} />
          <hemisphereLight args={['#ffffff', '#445566', 0.6]} />
          <directionalLight position={[120, 220, 160]} intensity={1.2} />
          <directionalLight position={[-150, 80, -120]} intensity={0.4} color="#9ad7ff" />
          <ViewCtx.Provider value={state}>
            <group ref={root} onPointerDown={onPick}>{children}</group>
          </ViewCtx.Provider>
          <MaterialModes root={root} mode={mode} section={section} />
          <Measure points={pts} />
          {grid && <gridHelper args={[gridSize, gridSize / 10, dark ? '#3a3f47' : '#9aa3ad', dark ? '#262a30' : '#c6ccd3']} userData={{ noViewMode: true }} />}
          {axes && <axesHelper args={[gridSize / 4]} />}
          <CameraRig preset={preset} fitToken={fit} root={root} ortho={ortho} controls={controls} />
          <OrbitControls ref={controls} makeDefault enableRotate={!ortho} enableDamping dampingFactor={0.12} />
          {showGizmo && !ortho && (
            <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
              <GizmoViewport axisColors={['#e11d48', '#16a34a', '#0891b2']} labelColor="white" />
            </GizmoHelper>
          )}
        </Canvas>
        {measuring && <div className="pointer-events-none absolute left-2 top-2 rounded bg-cyan-600/90 px-2 py-0.5 text-[11px] text-white">Measure: click two points on a surface</div>}
        {overlay}
        {legend && <div className="absolute bottom-2 left-2">{legend}</div>}
      </div>
    </div>
  )
}
