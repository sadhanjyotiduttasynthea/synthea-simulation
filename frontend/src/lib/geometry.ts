import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

/** Engineering coordinates: x right, y depth, z up, millimetres. Rendered inside a group rotated -90° about X. */
export type GeoKind = 'point' | 'line' | 'rectangle' | 'circle' | 'polygon' | 'cuboid' | 'cylinder' | 'sphere' | 'extrusion' | 'stl'
export interface GeoObject {
  id: string; name: string; kind: GeoKind; dims: Record<string, number>; points?: [number, number][]
  position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number]
  visible: boolean; color?: string; material?: { type: 'material' | 'formulation'; id: string } | null; stl_base64?: string
}
export interface GeometryDoc { id: string; project_id: string; name: string; units: string; objects: GeoObject[] }

export const IS_3D: Record<GeoKind, boolean> = { point: false, line: false, rectangle: false, circle: false, polygon: false, cuboid: true, cylinder: true, sphere: true, extrusion: true, stl: true }

export const DIM_FIELDS: Record<GeoKind, [string, string][]> = {
  point: [], line: [], rectangle: [['width', 'Width (x)'], ['depth', 'Depth (y)']], circle: [['radius', 'Radius']], polygon: [],
  cuboid: [['width', 'Width (x)'], ['depth', 'Depth (y)'], ['height', 'Height (z)']], cylinder: [['radius', 'Radius'], ['height', 'Height (axis)']],
  sphere: [['radius', 'Radius']], extrusion: [['height', 'Extrusion height (z)']], stl: [],
}

export function newObject(kind: GeoKind, n: number): GeoObject {
  const base = { id: `obj-${Math.random().toString(36).slice(2, 9)}`, name: `${kind[0].toUpperCase()}${kind.slice(1)} ${n}`, kind, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], visible: true, material: null }
  switch (kind) {
    case 'point': return { ...base, dims: {} }
    case 'line': return { ...base, dims: {}, points: [[0, 0], [40, 0]] }
    case 'rectangle': return { ...base, dims: { width: 40, depth: 25 } }
    case 'circle': return { ...base, dims: { radius: 15 } }
    case 'polygon': return { ...base, dims: {}, points: [[0, 0], [40, 0], [50, 20], [20, 35], [-5, 20]] }
    case 'cuboid': return { ...base, dims: { width: 40, depth: 25, height: 15 }, position: [0, 0, 7.5] }
    case 'cylinder': return { ...base, dims: { radius: 10, height: 30 }, position: [0, 0, 15] }
    case 'sphere': return { ...base, dims: { radius: 12 }, position: [0, 0, 12] }
    case 'extrusion': return { ...base, dims: { height: 10 }, points: [[0, 0], [40, 0], [50, 20], [20, 35], [-5, 20]] }
    default: return { ...base, dims: {} }
  }
}

const stlCache = new Map<string, THREE.BufferGeometry>()
export function parseStl(b64: string): THREE.BufferGeometry {
  const key = b64.length + ':' + b64.slice(0, 64) + b64.slice(-64)
  const hit = stlCache.get(key)
  if (hit) return hit
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const g = new STLLoader().parse(bin.buffer)
  g.computeVertexNormals()
  stlCache.set(key, g)
  return g
}

function shapeFrom(pts: [number, number][]): THREE.Shape {
  const s = new THREE.Shape()
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)))
  s.closePath()
  return s
}

/** Build the geometry in local engineering coordinates (z up, centred on the object origin). */
export function buildGeometry(o: GeoObject): THREE.BufferGeometry | null {
  const d = o.dims
  switch (o.kind) {
    case 'cuboid': return new THREE.BoxGeometry(d.width, d.depth, d.height)
    case 'cylinder': { const g = new THREE.CylinderGeometry(d.radius, d.radius, d.height, 64); g.rotateX(Math.PI / 2); return g }
    case 'sphere': return new THREE.SphereGeometry(d.radius, 48, 32)
    case 'rectangle': return new THREE.PlaneGeometry(d.width, d.depth)
    case 'circle': return new THREE.CircleGeometry(d.radius, 64)
    case 'polygon': return o.points && o.points.length >= 3 ? new THREE.ShapeGeometry(shapeFrom(o.points)) : null
    case 'extrusion': return o.points && o.points.length >= 3 ? new THREE.ExtrudeGeometry(shapeFrom(o.points), { depth: d.height, bevelEnabled: false }) : null
    case 'stl': return o.stl_base64 ? parseStl(o.stl_base64) : null
    default: return null
  }
}

function polyArea(p: [number, number][]) {
  let a = 0
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1 }
  return Math.abs(a) / 2
}
function polyPerimeter(p: [number, number][]) {
  let s = 0
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += Math.hypot(x2 - x1, y2 - y1) }
  return s
}

function meshMeasures(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position')
  const idx = g.getIndex()
  const n = idx ? idx.count : pos.count
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3()
  let vol = 0, area = 0
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2)
    vol += a.dot(ab.copy(b).cross(c)) / 6
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2
  }
  return { volume: Math.abs(vol), area }
}

/** Volume (mm³) and surface area (mm²) — analytic for primitives, triangle-mesh integration for STL. */
export function measures(o: GeoObject): { volume: number | null; area: number; method: string } {
  const d = o.dims
  const [sx, sy, sz] = o.scale
  const vs = Math.abs(sx * sy * sz)
  const uniform = Math.abs(sx - sy) < 1e-9 && Math.abs(sy - sz) < 1e-9
  const as = uniform ? sx * sx : NaN
  switch (o.kind) {
    case 'cuboid': return { volume: d.width * d.depth * d.height * vs, area: 2 * (d.width * d.depth * sx * sy + d.width * d.height * sx * sz + d.depth * d.height * sy * sz), method: 'analytic' }
    case 'cylinder': return { volume: Math.PI * d.radius ** 2 * d.height * vs, area: (2 * Math.PI * d.radius * (d.radius + d.height)) * (Number.isNaN(as) ? 1 : as), method: uniform ? 'analytic' : 'analytic (area ignores non-uniform scale)' }
    case 'sphere': return { volume: (4 / 3) * Math.PI * d.radius ** 3 * vs, area: 4 * Math.PI * d.radius ** 2 * (Number.isNaN(as) ? 1 : as), method: uniform ? 'analytic' : 'analytic (area ignores non-uniform scale)' }
    case 'rectangle': return { volume: null, area: d.width * d.depth * sx * sy, method: 'analytic' }
    case 'circle': return { volume: null, area: Math.PI * d.radius ** 2 * sx * sy, method: 'analytic' }
    case 'polygon': return { volume: null, area: polyArea(o.points ?? []) * sx * sy, method: 'shoelace' }
    case 'extrusion': { const A = polyArea(o.points ?? []); return { volume: A * d.height * vs, area: (2 * A + polyPerimeter(o.points ?? []) * d.height) * (Number.isNaN(as) ? 1 : as), method: 'analytic' } }
    case 'stl': {
      if (!o.stl_base64) return { volume: null, area: 0, method: 'no mesh' }
      const g = parseStl(o.stl_base64).clone()
      g.scale(sx, sy, sz)
      const m = meshMeasures(g)
      return { volume: m.volume, area: m.area, method: 'mesh integration (closed mesh assumed)' }
    }
    default: return { volume: null, area: 0, method: '—' }
  }
}

export function objectMatrix(o: GeoObject): THREE.Matrix4 {
  const e = new THREE.Euler(...(o.rotation.map((r) => (r * Math.PI) / 180) as [number, number, number]), 'XYZ')
  return new THREE.Matrix4().compose(new THREE.Vector3(...o.position), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(...o.scale))
}

export async function exportStl(objs: GeoObject[]): Promise<Blob> {
  const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js')
  const scene = new THREE.Scene()
  for (const o of objs) {
    if (!o.visible || !IS_3D[o.kind]) continue
    const g = buildGeometry(o)
    if (!g) continue
    const m = new THREE.Mesh(g)
    m.applyMatrix4(objectMatrix(o))
    scene.add(m)
  }
  scene.updateMatrixWorld(true)
  const out = new STLExporter().parse(scene, { binary: true }) as DataView
  return new Blob([out.buffer as ArrayBuffer], { type: 'model/stl' })
}

export async function fileToBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

export const MATERIAL_PALETTE = ['#c9a46c', '#e11d48', '#0891b2', '#7c3aed', '#16a34a', '#f59e0b', '#525252', '#db2777']
export function colorForKey(key: string) {
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return MATERIAL_PALETTE[h % MATERIAL_PALETTE.length]
}
