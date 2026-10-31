import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { Pause, Play, RotateCcw, Save, Upload, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Alert, Button, Field, KV, NumInput, PageHeader, Panel, Prov, Select, Spinner, Stat } from '../components/ui'
import { api, readFile } from '../lib/api'
import { fmt } from '../lib/format'
import { useActiveFormulation, useResults, useStore } from '../store'

interface PrintParams {
  shape: string
  geometry: { width: number; depth: number; diameter: number; inner_diameter: number; height: number; polygon?: number[][] }
  nozzle_diameter_mm: number
  nozzle_length_mm: number
  line_width_mm: number | null
  layer_height_mm: number
  print_speed_mm_s: number
  travel_speed_mm_s: number
  flow_rate_mm3_s: number | null
  extrusion_temperature_c: number
  bed_temperature_c: number
  infill_pct: number
  perimeters: number
  build_volume_mm: [number, number, number]
}

interface PrintResult {
  shape: string; layer_count: number; toolpath_points: number; extrusion_length_mm: number; travel_length_mm: number; toolpath_length_mm: number
  print_time_s: number; line_width_mm: number; deposited_volume_cm3: number; required_volumetric_flow_mm3_s: number; material_mass_g?: number; flow_ratio?: number
  path: [number, number, number, number][]; layers: { layer: number; z: number; extrusion_mm: number }[]
  assumptions: string[]; warnings: string[]; unsupported: string[]
  nozzle?: Record<string, number | string | null>
}

const DEFAULTS: PrintParams = {
  shape: 'cube', geometry: { width: 40, depth: 30, diameter: 40, inner_diameter: 18, height: 12 },
  nozzle_diameter_mm: 1.2, nozzle_length_mm: 10, line_width_mm: null, layer_height_mm: 1.0, print_speed_mm_s: 20, travel_speed_mm_s: 60,
  flow_rate_mm3_s: null, extrusion_temperature_c: 25, bed_temperature_c: 20, infill_pct: 40, perimeters: 1, build_volume_mm: [200, 200, 100],
}
const SHAPES: Record<string, string> = { cube: 'Rectangular block', cylinder: 'Cylinder (disc)', ring: 'Hollow ring', hexagon: 'Hexagonal prism', star: 'Five-point star', pyramid: 'Stepped pyramid', custom: 'Imported polygon' }
const S = 0.1 // scene units per mm

export default function Printing() {
  const { project, formulations, saveProject, toast, setAssistant, setResult, dark } = useStore()
  const active = useActiveFormulation()
  const results = useResults()
  const [p, setP] = useState<PrintParams>(() => ({ ...DEFAULTS, ...((project?.print_settings as Partial<PrintParams>) ?? {}) }))
  const [formId, setFormId] = useState<string | undefined>(active?.id)
  const [res, setRes] = useState<PrintResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(10)
  const [progress, setProgress] = useState(0)
  const simTime = useRef(0)
  const form = formulations.find((f) => f.id === formId) ?? active

  useEffect(() => {
    setFormId(active?.id)
  }, [active?.id])
  useEffect(() => {
    setAssistant('printing', { print: res ? { ...res, path: undefined, layers: undefined } : null })
  }, [res, setAssistant])

  const generate = async (params = p) => {
    setBusy(true)
    setErr(null)
    try {
      const rheo = form?.rheology && form.rheology.yield_stress_pa !== null ? { ...form.rheology, source: `${form.rheology.data_type}: ${form.rheology.source || 'formulation record'}` } : null
      const r = await api.post<PrintResult>('/api/print/toolpath', { ...params, lines: form?.lines ?? [], rheology: rheo })
      setRes(r)
      simTime.current = 0
      setProgress(0)
      setPlaying(true)
      const { path: _path, ...summary } = r
      void _path
      setResult('print', { ...summary, layers: undefined, formulation: form?.name })
      setResult('printParams', params)
    } catch (e) {
      setErr((e as Error).message)
      setRes(null)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { generate() }, [form?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const g = (k: keyof PrintParams['geometry'], v: number | null) => setP({ ...p, geometry: { ...p.geometry, [k]: v ?? 0 } })
  const num = (k: keyof PrintParams, v: number | null) => setP({ ...p, [k]: v })

  const importPolygon = async () => {
    try {
      const txt = await readFile('.csv,.txt,.json')
      let pts: number[][]
      if (txt.trim().startsWith('[') || txt.trim().startsWith('{')) {
        const j = JSON.parse(txt)
        pts = Array.isArray(j) ? j : j.polygon
      } else {
        pts = txt.split(/\r?\n/).map((l) => l.split(/[,;\s]+/).map(Number)).filter((r) => r.length >= 2 && r.every((v) => Number.isFinite(v))).map((r) => [r[0], r[1]])
      }
      if (!pts || pts.length < 3) throw new Error('Need at least 3 (x, y) points in mm')
      const next = { ...p, shape: 'custom', geometry: { ...p.geometry, polygon: pts } }
      setP(next)
      generate(next)
      toast(`Imported polygon with ${pts.length} vertices`, 'success')
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error')
    }
  }

  const timeline = useMemo(() => buildTimeline(res, p), [res, p.print_speed_mm_s, p.travel_speed_mm_s])  // eslint-disable-line react-hooks/exhaustive-deps
  const total = timeline?.total ?? 0
  const layerNow = res && timeline ? res.path[Math.min(timeline.indexAt(simTime.current), res.path.length - 1)]?.[2] : 0

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="3D Printing Lab"
        subtitle="Virtual food printer: real toolpath generation (perimeters + rectilinear infill), layer-by-layer deposition and extrusion calculations."
        actions={<>
          <Button size="sm" onClick={() => saveProject({ ...project!, print_settings: p as unknown as Record<string, unknown> }).then(() => toast('Printer settings saved to project', 'success'))}><Save className="h-3.5 w-3.5" />Save settings</Button>
          <Button variant="primary" onClick={() => generate()} loading={busy}><Wand2 className="h-3.5 w-3.5" />Generate toolpath</Button>
        </>}
      />
      <div className="grid gap-3 @5xl:min-h-0 @5xl:flex-1 @5xl:grid-cols-[250px_minmax(0,1fr)_300px]">
        <div className="space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          <Panel title="Material">
            <Field label="Formulation"><Select value={form?.id ?? ''} onChange={(e) => setFormId(e.target.value)}>{formulations.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Field>
            <div className="mt-2 text-[11px]">Rheology: {form?.rheology && form.rheology.yield_stress_pa !== null ? <><Prov kind={form.rheology.data_type} /> τ₀ {form.rheology.yield_stress_pa} Pa · K {form.rheology.consistency_index_pa_sn} · n {form.rheology.flow_behaviour_index}</> : <Prov kind="missing" />}</div>
            <p className="mt-1 text-[10px] text-neutral-500">Density for mass calculation: Choi–Okos at extrusion temperature (calculated).</p>
          </Panel>
          <Panel title="Geometry">
            <div className="space-y-2">
              <Field label="Shape"><Select value={p.shape} onChange={(e) => setP({ ...p, shape: e.target.value })}>{Object.entries(SHAPES).map(([k, v]) => <option key={k} value={k} disabled={k === 'custom' && !p.geometry.polygon}>{v}</option>)}</Select></Field>
              <div className="grid grid-cols-2 gap-2">
                {(p.shape === 'cube' || p.shape === 'pyramid') && <><Field label="Width [mm]"><NumInput value={p.geometry.width} onChange={(v) => g('width', v)} /></Field><Field label="Depth [mm]"><NumInput value={p.geometry.depth} onChange={(v) => g('depth', v)} /></Field></>}
                {['cylinder', 'ring', 'hexagon', 'star'].includes(p.shape) && <Field label="Diameter [mm]"><NumInput value={p.geometry.diameter} onChange={(v) => g('diameter', v)} /></Field>}
                {p.shape === 'ring' && <Field label="Inner Ø [mm]"><NumInput value={p.geometry.inner_diameter} onChange={(v) => g('inner_diameter', v)} /></Field>}
                <Field label="Height [mm]"><NumInput value={p.geometry.height} onChange={(v) => g('height', v)} /></Field>
              </div>
              <Button size="sm" className="w-full" onClick={importPolygon}><Upload className="h-3.5 w-3.5" />Import 2-D outline (CSV/JSON, mm)</Button>
              <p className="text-[10px] text-neutral-500">Imported outlines are extruded to the given height (simple, non-self-intersecting polygons).</p>
            </div>
          </Panel>
          <Panel title="Toolpath strategy">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Perimeters"><NumInput value={p.perimeters} allowNull={false} onChange={(v) => num('perimeters', Math.max(0, Math.round(v ?? 1)))} /></Field>
              <Field label="Infill [%]"><NumInput value={p.infill_pct} allowNull={false} onChange={(v) => num('infill_pct', Math.min(100, Math.max(0, v ?? 0)))} /></Field>
              <Field label="Line width [mm]" hint="empty = 1.1 × nozzle" className="col-span-2"><NumInput value={p.line_width_mm} onChange={(v) => num('line_width_mm', v)} placeholder="auto" /></Field>
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-2 @5xl:min-h-0">
          <div className="relative min-h-[380px] flex-1 overflow-hidden rounded border border-neutral-200 bg-gradient-to-b from-neutral-100 to-neutral-200 dark:border-neutral-800 dark:from-neutral-900 dark:to-neutral-950">
            <Canvas camera={{ position: [5, 4.2, 6.2], fov: 40 }} dpr={[1, 2]}>
              <color attach="background" args={[dark ? '#111111' : '#f1f1f1']} />
              <ambientLight intensity={0.7} />
              <directionalLight position={[10, 20, 10]} intensity={1.1} />
              <PrinterScene res={res} params={p} timeline={timeline} playing={playing} speed={speed} simTime={simTime} onProgress={setProgress} onDone={() => setPlaying(false)} />
              <OrbitControls target={[0, 0.6, 0]} maxPolarAngle={Math.PI / 2.05} />
            </Canvas>
            {busy && <div className="absolute left-3 top-3"><Spinner label="Generating toolpath…" /></div>}
            <div className="absolute right-3 top-3 rounded bg-white/85 px-2 py-1 text-[11px] shadow-sm dark:bg-neutral-900/85">
              Layer <b className="num">{res ? Math.min(res.layer_count, Math.max(1, Math.round((layerNow ?? 0) / p.layer_height_mm))) : 0}</b> / {res?.layer_count ?? 0} · t = <b className="num">{fmt(progress * total / 60, 1)}</b> / {fmt(total / 60, 1)} min
            </div>
          </div>
          <div className="flex items-center gap-2 rounded border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
            <Button size="sm" variant="primary" onClick={() => { if (progress >= 0.999) { simTime.current = 0 } setPlaying(!playing) }} disabled={!res}>{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}{playing ? 'Pause' : 'Play'}</Button>
            <Button size="sm" onClick={() => { simTime.current = 0; setProgress(0) }} disabled={!res}><RotateCcw className="h-3.5 w-3.5" />Restart</Button>
            <input type="range" min={0} max={1} step={0.001} value={progress} onChange={(e) => { simTime.current = Number(e.target.value) * total; setProgress(Number(e.target.value)) }} className="flex-1" aria-label="Print progress" />
            <span className="num w-10 text-right text-xs">{fmt(progress * 100, 0)} %</span>
            <Select className="w-24" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 5, 10, 25, 50, 100].map((s) => <option key={s} value={s}>{s}× speed</option>)}</Select>
          </div>
        </div>

        <div className="space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          <Panel title="Printer parameters">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Nozzle Ø [mm]"><NumInput value={p.nozzle_diameter_mm} allowNull={false} onChange={(v) => num('nozzle_diameter_mm', v)} /></Field>
              <Field label="Nozzle length [mm]"><NumInput value={p.nozzle_length_mm} allowNull={false} onChange={(v) => num('nozzle_length_mm', v)} /></Field>
              <Field label="Print speed [mm/s]"><NumInput value={p.print_speed_mm_s} allowNull={false} onChange={(v) => num('print_speed_mm_s', v)} /></Field>
              <Field label="Travel speed [mm/s]"><NumInput value={p.travel_speed_mm_s} allowNull={false} onChange={(v) => num('travel_speed_mm_s', v)} /></Field>
              <Field label="Layer height [mm]"><NumInput value={p.layer_height_mm} allowNull={false} onChange={(v) => num('layer_height_mm', v)} /></Field>
              <Field label="Flow rate [mm³/s]" hint="empty = matched"><NumInput value={p.flow_rate_mm3_s} onChange={(v) => num('flow_rate_mm3_s', v)} placeholder="auto" /></Field>
              <Field label="Extrusion T [°C]"><NumInput value={p.extrusion_temperature_c} allowNull={false} onChange={(v) => num('extrusion_temperature_c', v)} /></Field>
              <Field label="Bed T [°C]" hint="recorded only"><NumInput value={p.bed_temperature_c} allowNull={false} onChange={(v) => num('bed_temperature_c', v)} /></Field>
              {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                <Field key={ax} label={`Build volume ${ax} [mm]`}><NumInput value={p.build_volume_mm[i]} allowNull={false} onChange={(v) => { const b = [...p.build_volume_mm] as [number, number, number]; b[i] = v ?? 100; setP({ ...p, build_volume_mm: b }) }} /></Field>
              ))}
            </div>
          </Panel>
          {err && <Alert kind="error">{err}</Alert>}
          {res && (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <Stat label="Print time" value={fmt(res.print_time_s / 60, 1)} unit="min" prov="calculated" />
                <Stat label="Layers" value={res.layer_count} />
                <Stat label="Toolpath length" value={fmt(res.toolpath_length_mm / 1000, 2)} unit="m" sub={`extrude ${fmt(res.extrusion_length_mm / 1000, 2)} m · travel ${fmt(res.travel_length_mm / 1000, 2)} m`} />
                <Stat label="Material" value={fmt(res.material_mass_g, 1)} unit="g" sub={`${fmt(res.deposited_volume_cm3, 2)} cm³`} />
              </div>
              <Panel title="Extrusion" actions={<Prov kind="calculated" />}>
                <KV rows={[
                  ['Line width', `${fmt(res.line_width_mm, 2)} mm`],
                  ['Required flow Q = w·h·v', `${fmt(res.required_volumetric_flow_mm3_s, 2)} mm³/s`],
                  ['Set flow / required', res.flow_ratio ? `${fmt(res.flow_ratio * 100, 0)} %` : 'matched (auto)'],
                  ['Toolpath points', res.toolpath_points],
                ]} />
              </Panel>
              {res.nozzle ? (
                <Panel title="Nozzle flow (Herschel–Bulkley)" actions={<Prov kind="predicted" />}>
                  <KV rows={[
                    ['Pressure drop', `${fmt(res.nozzle.pressure_drop_kpa as number, 2)} kPa`],
                    ['Wall shear rate', `${fmt(res.nozzle.wall_shear_rate_1_s as number, 1)} 1/s`],
                    ['Wall shear stress', `${fmt(res.nozzle.wall_shear_stress_pa as number, 1)} Pa`],
                    ['Apparent viscosity (wall)', `${fmt(res.nozzle.apparent_viscosity_pa_s as number, 3)} Pa·s`],
                    ['Plug fraction of radius', fmt(res.nozzle.plug_fraction as number, 2)],
                    ['τ₀ / self-weight stress at base', fmt(res.nozzle.yield_vs_self_weight as number, 2)],
                  ]} />
                  <p className="mt-1 text-[10px] text-neutral-500">{res.nozzle.note as string} {res.nozzle.note_shape as string} Source: {res.nozzle.source as string}</p>
                </Panel>
              ) : null}
              {res.warnings.map((w, i) => <Alert key={i} kind="warn">{w}</Alert>)}
              <Panel title="Not predicted">
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-neutral-600 dark:text-neutral-400">{res.unsupported.map((u, i) => <li key={i}>{u}</li>)}</ul>
              </Panel>
              <Panel title="Assumptions"><ul className="list-disc space-y-0.5 pl-4 text-[11px] text-neutral-600 dark:text-neutral-400">{res.assumptions.map((u, i) => <li key={i}>{u}</li>)}</ul></Panel>
            </>
          )}
          {!!results.print && !res && <p className="text-xs text-neutral-500">Generating…</p>}
        </div>
      </div>
    </div>
  )
}

interface Timeline { cum: Float64Array; total: number; indexAt: (t: number) => number }

function buildTimeline(res: PrintResult | null, p: PrintParams): Timeline | null {
  if (!res || res.path.length < 2) return null
  const n = res.path.length
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const a = res.path[i - 1], b = res.path[i]
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    cum[i] = cum[i - 1] + d / (b[3] ? p.print_speed_mm_s : p.travel_speed_mm_s)
  }
  const indexAt = (t: number) => {
    let lo = 0, hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (cum[mid] <= t) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  return { cum, total: cum[n - 1], indexAt }
}

function PrinterScene({ res, params, timeline, playing, speed, simTime, onProgress, onDone }: {
  res: PrintResult | null; params: PrintParams; timeline: Timeline | null; playing: boolean; speed: number
  simTime: React.MutableRefObject<number>; onProgress: (p: number) => void; onDone: () => void
}) {
  const head = useRef<THREE.Group>(null)
  const gantry = useRef<THREE.Group>(null)
  const lastReport = useRef(0)
  const [bx, by, bz] = params.build_volume_mm

  // one instanced box per extrusion segment (bead: line width x layer height) + mapping path index -> segments done
  const { matrices, colors, segsBefore, nSeg } = useMemo(() => {
    if (!res) return { matrices: [] as THREE.Matrix4[], colors: [] as THREE.Color[], segsBefore: new Int32Array(0), nSeg: 0 }
    const mats: THREE.Matrix4[] = []
    const cols: THREE.Color[] = []
    const before = new Int32Array(res.path.length)
    const maxZ = Math.max(...res.path.map((q) => q[2]), 1)
    const c0 = new THREE.Color('#d6b98c'), c1 = new THREE.Color('#a8743f')
    const w = res.line_width_mm * S, h = params.layer_height_mm * S
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0)
    for (let i = 1; i < res.path.length; i++) {
      before[i - 1] = mats.length
      const a = res.path[i - 1], b = res.path[i]
      if (!b[3]) continue
      const dx = (b[0] - a[0]) * S, dz = -(b[1] - a[1]) * S
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) continue
      q.setFromAxisAngle(up, Math.atan2(-dz, dx))
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(((a[0] + b[0]) / 2) * S, b[2] * S - h / 2, (-(a[1] + b[1]) / 2) * S), q, new THREE.Vector3(len + w * 0.5, h, w))
      mats.push(m)
      cols.push(c0.clone().lerp(c1, b[2] / maxZ))
    }
    before[res.path.length - 1] = mats.length
    return { matrices: mats, colors: cols, segsBefore: before, nSeg: mats.length }
  }, [res, params.layer_height_mm])
  const inst = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const m = inst.current
    if (!m) return
    matrices.forEach((mat, k) => { m.setMatrixAt(k, mat); m.setColorAt(k, colors[k]) })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.count = 0
  }, [matrices, colors])

  useFrame((_, dt) => {
    if (!res || !timeline) return
    if (playing) {
      simTime.current = Math.min(simTime.current + dt * speed, timeline.total)
      if (simTime.current >= timeline.total) onDone()
    }
    const t = simTime.current
    const i = timeline.indexAt(t)
    const a = res.path[i], b = res.path[Math.min(i + 1, res.path.length - 1)]
    const seg = timeline.cum[Math.min(i + 1, res.path.length - 1)] - timeline.cum[i]
    const f = seg > 0 ? Math.min(1, (t - timeline.cum[i]) / seg) : 1
    const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f
    if (head.current) head.current.position.set(x * S, z * S, -y * S)
    if (gantry.current) gantry.current.position.set(0, z * S, -y * S)
    if (inst.current) inst.current.count = Math.min(nSeg, segsBefore[i] + (b[3] && f > 0.999 ? 1 : 0))
    if (performance.now() - lastReport.current > 100) {
      lastReport.current = performance.now()
      onProgress(timeline.total ? t / timeline.total : 0)
    }
  })

  const nozzleR = (params.nozzle_diameter_mm / 2) * S
  return (
    <group>
      {/* bed */}
      <mesh position={[0, -0.05, 0]} receiveShadow>
        <boxGeometry args={[bx * S, 0.1, by * S]} />
        <meshStandardMaterial color="#d4d4d4" metalness={0.2} roughness={0.6} />
      </mesh>
      <gridHelper args={[Math.max(bx, by) * S, Math.max(bx, by) / 10, '#a3a3a3', '#bdbdbd']} position={[0, 0.001, 0]} />
      {/* frame */}
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], k) => (
        <mesh key={k} position={[(sx * bx * S) / 2, (bz * S) / 2, (sz * by * S) / 2]}>
          <boxGeometry args={[0.12, bz * S, 0.12]} />
          <meshStandardMaterial color="#262626" />
        </mesh>
      ))}
      {/* gantry (moves in Y and Z) */}
      <group ref={gantry}>
        <mesh position={[0, 1.6, 0]}>
          <boxGeometry args={[bx * S + 0.2, 0.12, 0.18]} />
          <meshStandardMaterial color="#404040" />
        </mesh>
      </group>
      {/* printhead */}
      <group ref={head}>
        <mesh position={[0, 0.3 + nozzleR, 0]}>
          <coneGeometry args={[0.18, 0.5, 20]} />
          <meshStandardMaterial color="#9ca3af" metalness={0.8} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.06, 0]} rotation={[Math.PI, 0, 0]}>
          <cylinderGeometry args={[nozzleR + 0.02, nozzleR + 0.02, 0.12, 16]} />
          <meshStandardMaterial color="#6b7280" metalness={0.9} roughness={0.2} />
        </mesh>
        <mesh position={[0, 1.05, 0]}>
          <cylinderGeometry args={[0.45, 0.45, 1.1, 24]} />
          <meshStandardMaterial color="#b91c1c" roughness={0.5} />
        </mesh>
        <mesh position={[0, 1.7, 0]}>
          <boxGeometry args={[0.9, 0.3, 0.6]} />
          <meshStandardMaterial color="#171717" />
        </mesh>
      </group>
      {/* deposited material */}
      {nSeg > 0 && (
        <instancedMesh key={nSeg + ':' + matrices.length} ref={inst} args={[undefined, undefined, nSeg]} frustumCulled={false}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial roughness={0.85} />
        </instancedMesh>
      )}
    </group>
  )
}
