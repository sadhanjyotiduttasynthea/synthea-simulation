import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Boxes, Download, Grid3x3, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import { Equation } from '../components/Equation'
import { GraphicsView } from '../components/GraphicsView'
import { Plot } from '../components/Plot'
import { Alert, Badge, Button, Field, Input, KV, NumInput, PageHeader, Panel, Prov, Select, Spinner, Tabs, cx, inputCls } from '../components/ui'
import { api, download } from '../lib/api'
import { fmtSci, toCsv } from '../lib/format'
import { type GeoObject, type GeometryDoc, buildGeometry, objectMatrix } from '../lib/geometry'
import type { Material } from '../lib/sci'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector, ResultsSlot, useEquations } from '../workspace/Slots'
import { log } from '../workspace/wsStore'

type Tab = 'model' | 'physics' | 'mesh' | 'study' | 'results'
interface BC { type: 'convection' | 'temperature' | 'insulated'; h?: number; T_inf?: number; value?: number }
interface Twin {
  id: string; project_id: string; name: string; geometry_object_id: string | null; material: { type: 'material' | 'formulation'; id: string } | null
  physics: { kind: string; enabled: boolean }[]; conditions: { initial_temperature: number; concentration: number | null }
  boundaries: Record<string, BC>; flow: { flow_rate_ml_min: number; temperature: number; material_id?: string }
  diffusion: { initial: number; D_source: string; D_manual: number | null; surface_type: string; surface_value: number; k_m: number | null }
  kinetics: { material_id: string | null; initial_native_fraction: number }; property_overrides: Record<string, number>
  mesh: { size_mm: number | null }; study: { type: string; t_end: number; dt: number; frames: number; sweep: { parameter: string; values: number[] }; sensitivity: { delta: number } }
  allow_extrapolation: boolean
}
interface View { x: number[]; y: number[]; xlabel: string; ylabel: string; frames: (number | null)[][][] }
interface FieldRes { unit: string; times: (number | null)[]; views?: Record<string, View>; profile?: { r: number[]; frames: number[][] }; probes: Record<string, number[]>; mean: number[]; balance?: { relative_error: number } | null; metrics?: Record<string, number> }
interface Study {
  id: string; name: string; type: string; created: string; physics: string[]; mesh?: Record<string, number | string | number[]>; log: string[]; warnings: string[]; extrapolated: boolean
  provenance: { quantity: string; source?: string; type: string; model_id?: string; record_id?: string; model?: string; page?: number; value?: number; unit?: string; conditions?: Record<string, number> }[]
  heat?: FieldRes; diffusion?: FieldRes; reaction?: { unit: string; views?: Record<string, { x: number[]; y: number[]; xlabel: string; ylabel: string; frames: number[][][] }>; mean: number; centre: number }
  flow?: { r_mm: number[]; velocity_m_s: number[]; shear_rate_1_s: number[]; apparent_viscosity_pa_s: (number | null)[]; shear_stress_pa: number[]; pressure_drop_pa: number; wall_shear_rate_1_s: number; wall_shear_stress_pa: number; flow_rate_m3_s: number; mean_velocity_m_s: number; max_velocity_m_s: number; plug_radius_mm: number; model_id: string; hb: Record<string, number>; section: { x: number[]; y: number[]; xlabel: string; ylabel: string; fields: Record<string, (number | null)[][]> } }
  sweep?: { parameter: string; rows: Record<string, number>[] }; sensitivity?: { base: Record<string, number>; rows: { parameter: string; normalised_sensitivity: number | null; final_centre_C: number }[]; note: string; metric: string }
  validation?: { metrics?: { label: string; probe: string; n: number; rmse: number; bias: number; mae: number; r2: number; max_abs_error: number; points: { t: number; observed: number; predicted: number }[] } }
}

const PHYSICS = [
  { kind: 'heat', label: 'Heat transfer in solids/pastes', eq: '\\rho c_p \\dfrac{\\partial T}{\\partial t} = \\nabla\\cdot\\left(k\\,\\nabla T\\right)', bc: '-k\\,\\nabla T\\cdot\\mathbf{n} = h\\,(T - T_\\infty)' },
  { kind: 'flow', label: 'Laminar flow (Herschel–Bulkley, fully developed)', eq: '\\tau = \\tau_0 + K\\dot\\gamma^{n},\\quad u(r)=\\int_r^R \\dot\\gamma\\!\\left(\\tfrac{\\tau_w s}{R}\\right)ds,\\quad \\Delta P = \\dfrac{2\\tau_w L}{R}', bc: 'u(R)=0\\;\\text{(no slip)}' },
  { kind: 'diffusion', label: 'Mass diffusion (moisture)', eq: '\\dfrac{\\partial c}{\\partial t} = \\nabla\\cdot\\left(D\\,\\nabla c\\right)', bc: 'c = c_s\\;\\text{or}\\;-D\\nabla c\\cdot\\mathbf n = k_m(c-c_\\infty)' },
  { kind: 'kinetics', label: 'Reaction kinetics (first order, coupled to T)', eq: '\\dfrac{dX}{dt} = -k(T)\\,X,\\; k(T)=k_{ref}e^{-\\frac{E_a}{R}\\left(\\frac1T-\\frac1{T_{ref}}\\right)}', bc: '' },
]

export default function TwinPage() {
  const { project, formulations, toast } = useStore()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'model'
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t); return n })
  const [twins, setTwins] = useState<Twin[]>([])
  const [twin, setTwin] = useState<Twin | null>(null)
  const [geo, setGeo] = useState<GeometryDoc | null>(null)
  const [mats, setMats] = useState<Material[]>([])
  const [studies, setStudies] = useState<Study[]>([])
  const [study, setStudy] = useState<Study | null>(null)
  const [mesh, setMesh] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const saveT = useRef<number | undefined>(undefined)
  const tid = params.get('twin') ?? twins[0]?.id

  const loadTwins = useCallback(() => project && api.get<Twin[]>(`/api/twins?project_id=${project.id}`).then(setTwins), [project])
  useEffect(() => {
    loadTwins()
    if (project) api.get<GeometryDoc>(`/api/geometries?project_id=${project.id}`).then(setGeo)
    api.get<Material[]>('/api/materials').then(setMats)
  }, [project, loadTwins])
  useEffect(() => { setTwin(twins.find((t) => t.id === tid) ?? null) }, [tid, twins])
  const loadStudies = useCallback(async (select?: string) => {
    if (!tid) return setStudies([])
    const s = await api.get<Study[]>(`/api/studies?twin_id=${tid}`)
    setStudies(s)
    const pick = select ?? s[s.length - 1]?.id
    if (pick) setStudy(await api.get<Study>(`/api/studies/${pick}`))
    else setStudy(null)
  }, [tid])
  useEffect(() => { loadStudies(); setMesh(null) }, [loadStudies])

  const persist = (t: Twin) => {
    setTwin(t)
    setTwins((ts) => ts.map((x) => (x.id === t.id ? t : x)))
    window.clearTimeout(saveT.current)
    saveT.current = window.setTimeout(() => api.put(`/api/twins/${t.id}`, t).then(() => refreshTree()), 350)
  }
  const create = async () => {
    if (!project) return
    const bar = geo?.objects.find((o) => ['cuboid', 'cylinder', 'sphere'].includes(o.kind))
    const t = await api.post<Twin>('/api/twins', { project_id: project.id, name: `Digital twin ${twins.length + 1}`, geometry_object_id: bar?.id ?? null, material: bar?.material ?? null })
    await loadTwins()
    setParams({ twin: t.id, tab: 'model' })
    refreshTree()
    log('info', 'twin', `Created ${t.name}`)
  }
  useCommand('twin.new', create)
  useCommand('twin.addPhysics', (k) => {
    if (!twin) return toast('Create or select a digital twin first', 'error')
    const kind = String(k)
    const exists = twin.physics.find((p) => p.kind === kind)
    persist({ ...twin, physics: exists ? twin.physics.map((p) => (p.kind === kind ? { ...p, enabled: true } : p)) : [...twin.physics, { kind, enabled: true }] })
    setTab('physics')
    log('info', 'twin', `Physics enabled: ${kind}`)
  })
  const buildMesh = async () => {
    if (!twin) return
    try {
      setBusy('Building mesh…')
      const m = await api.post<Record<string, unknown>>(`/api/twins/${twin.id}/mesh`)
      setMesh(m)
      log('info', 'mesh', `${m.cells} ${m.element} (${(m.shape as number[]).join('×')}), max aspect ratio ${(m.max_aspect_ratio as number).toFixed(2)}`)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  useCommand('mesh.build', buildMesh)
  const compute = async () => {
    if (!twin) return toast('Select a digital twin', 'error')
    setBusy('Solving…')
    log('info', 'solver', `Study started: ${twin.name} (${twin.study.type})`)
    try {
      const s = await api.post<Study>(`/api/twins/${twin.id}/run`)
      s.log.forEach((l) => log('info', 'solver', l))
      s.warnings.forEach((w) => log('warn', 'solver', w))
      log('success', 'solver', `Study ${s.id} finished${s.extrapolated ? ' (contains flagged extrapolation)' : ''}`)
      await loadStudies(s.id)
      setTab('results')
    } catch (e) {
      log('error', 'solver', (e as Error).message)
      toast((e as Error).message, 'error')
    } finally { setBusy(null) }
  }
  useCommand('study.compute', compute)

  const obj = geo?.objects.find((o) => o.id === twin?.geometry_object_id) ?? null
  const enabled = twin?.physics.filter((p) => p.enabled).map((p) => p.kind) ?? []
  useEquations(PHYSICS.filter((p) => enabled.includes(p.kind)).flatMap((p) => [{ title: p.label, latex: p.eq }, ...(p.bc ? [{ title: `${p.label} — boundary condition`, latex: p.bc }] : [])]), [enabled.join()])
  useCommand('results.export', () => study && exportStudy(study))

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Digital Twin" subtitle="Geometry + materials (approved models) + physics + conditions + mesh + study + results + validation. Real finite-volume solutions; provenance is recorded for every input."
        actions={<>
          <Select className="w-56" value={tid ?? ''} onChange={(e) => setParams({ twin: e.target.value, tab })}>{twins.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}{!twins.length && <option value="">no twins</option>}</Select>
          <Button size="sm" onClick={create}><Plus className="h-3.5 w-3.5" />New twin</Button>
          {twin && <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Delete ${twin.name} and its studies?`)) { await api.del(`/api/twins/${twin.id}`); setParams({}); loadTwins(); refreshTree() } }}><Trash2 className="h-3.5 w-3.5" /></Button>}
          <Button variant="primary" onClick={compute} loading={busy === 'Solving…'} disabled={!twin}><Play className="h-3.5 w-3.5" />Compute (F5)</Button>
        </>} />
      {!twin ? (
        <Panel><div className="py-10 text-center text-sm text-neutral-500"><Boxes className="mx-auto mb-2 h-8 w-8 text-rose-600" />No digital twin yet. Create one; it starts from the first solid in the project geometry.<div className="mt-3"><Button variant="primary" onClick={create}><Plus className="h-3.5 w-3.5" />New digital twin</Button></div></div></Panel>
      ) : (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'model', label: '1 · Model & provenance' }, { id: 'physics', label: '2 · Physics & conditions' }, { id: 'mesh', label: '3 · Mesh' }, { id: 'study', label: '4 · Study' }, { id: 'results', label: `5 · Results${studies.length ? ` (${studies.length})` : ''}` }]} />
          <div className="mt-3 min-h-0 flex-1">
            {busy && <div className="mb-2"><Spinner label={busy} /></div>}
            {tab === 'model' && <ModelTab twin={twin} geo={geo} mats={mats} formulations={formulations} onChange={persist} nav={nav} hasStudy={!!study} />}
            {tab === 'physics' && <PhysicsTab twin={twin} obj={obj} mats={mats} onChange={persist} />}
            {tab === 'mesh' && <MeshTab twin={twin} mesh={mesh} onBuild={buildMesh} onChange={persist} obj={obj} />}
            {tab === 'study' && <StudyTab twin={twin} onChange={persist} onRun={compute} />}
            {tab === 'results' && <ResultsTab study={study} studies={studies} obj={obj} onSelect={(id) => loadStudies(id)} onDelete={async (id) => { await api.del(`/api/studies/${id}`); loadStudies() }} onCompared={(s) => setStudy(s)} />}
          </div>
        </>
      )}
      {study && (
        <ResultsSlot>
          <div className="text-xs">
            <div className="mb-1 font-semibold">{study.name} <span className="font-normal text-neutral-500">{new Date(study.created).toLocaleString()}</span> {study.extrapolated && <Badge tone="red">extrapolated</Badge>}</div>
            {study.heat?.metrics && <KV rows={Object.entries(study.heat.metrics).map(([k, v]) => [k.replace(/_/g, ' '), `${fmtSci(v, 5)} °C`])} />}
            {study.flow && <KV rows={[['pressure drop', `${fmtSci(study.flow.pressure_drop_pa, 5)} Pa`], ['wall shear rate', `${fmtSci(study.flow.wall_shear_rate_1_s, 4)} 1/s`], ['flow rate (numerical)', `${fmtSci(study.flow.flow_rate_m3_s * 6e7, 4)} mL/min`]]} />}
            {study.validation?.metrics && <div className="mt-1">Validation vs {study.validation.metrics.label}: RMSE {fmtSci(study.validation.metrics.rmse, 3)}, bias {fmtSci(study.validation.metrics.bias, 3)}</div>}
          </div>
        </ResultsSlot>
      )}
    </div>
  )
}

function exportStudy(s: Study) {
  const rows: (string | number | null)[][] = [['field', 'probe', 'time_s', 'value']]
  for (const f of ['heat', 'diffusion'] as const) {
    const r = s[f]
    if (!r) continue
    Object.entries(r.probes).forEach(([p, vals]) => vals.forEach((v, i) => rows.push([f, p, r.times[i], v])))
    r.mean.forEach((v, i) => rows.push([f, 'volume mean', r.times[i], v]))
  }
  if (s.flow) s.flow.r_mm.forEach((r, i) => rows.push(['flow', `r=${r.toFixed(4)} mm`, null, s.flow!.velocity_m_s[i]]))
  download(`${s.id}_results.csv`, toCsv(rows), 'text/csv')
  download(`${s.id}.json`, JSON.stringify(s, null, 1))
}

// ------------------------------------------------------------------ Model tab
const KIND_STYLE: Record<string, string> = { paper: 'border-sky-400 bg-sky-50 dark:bg-sky-950/40', record: 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40', model: 'border-cyan-400 bg-cyan-50 dark:bg-cyan-950/40', material: 'border-amber-400 bg-amber-50 dark:bg-amber-950/40', formulation: 'border-amber-400 bg-amber-50 dark:bg-amber-950/40', geometry: 'border-neutral-400 bg-neutral-50 dark:bg-white/5', twin: 'border-rose-500 bg-rose-50 dark:bg-rose-950/40', study: 'border-violet-400 bg-violet-50 dark:bg-violet-950/40', results: 'border-violet-400 bg-white dark:bg-white/5', validation: 'border-emerald-600 bg-emerald-100 dark:bg-emerald-900/40' }
function DepNode({ data }: NodeProps<Node<{ label: string; kind: string; sub: string }>>) {
  return (
    <div className={cx('w-44 rounded border-2 px-2 py-1 text-left text-[11px] text-neutral-900 dark:text-neutral-100', KIND_STYLE[data.kind] ?? '')}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5" />
      <div className="text-[9px] uppercase tracking-wider text-neutral-500">{data.kind}</div>
      <div className="line-clamp-2 font-medium">{data.label}</div>
      {data.sub && <div className="truncate text-[10px] text-neutral-500">{data.sub}</div>}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5" />
    </div>
  )
}
const ORDER = ['paper', 'record', 'model', 'material', 'formulation', 'geometry', 'twin', 'study', 'results', 'validation']

function ModelTab({ twin, geo, mats, formulations, onChange, nav, hasStudy }: { twin: Twin; geo: GeometryDoc | null; mats: Material[]; formulations: { id: string; name: string }[]; onChange: (t: Twin) => void; nav: (p: string) => void; hasStudy: boolean }) {
  const [deps, setDeps] = useState<{ nodes: { id: string; label: string; kind: string; sub: string }[]; edges: { source: string; target: string }[] } | null>(null)
  const dark = useStore((s) => s.dark)
  useEffect(() => { api.get<typeof deps>(`/api/twins/${twin.id}/dependencies`).then(setDeps) }, [twin.id, twin.material?.id, twin.geometry_object_id, hasStudy])
  const flow = useMemo(() => {
    if (!deps) return { nodes: [] as Node[], edges: [] as Edge[] }
    const cols: Record<string, number> = {}
    const nodes: Node[] = deps.nodes.map((n) => {
      const col = ['paper'].includes(n.kind) ? 0 : ['record', 'model'].includes(n.kind) ? 1 : ['material', 'formulation', 'geometry'].includes(n.kind) ? 2 : n.kind === 'twin' ? 3 : n.kind === 'study' ? 4 : n.kind === 'results' ? 5 : 6
      cols[col] = (cols[col] ?? 0) + 1
      return { id: n.id, type: 'dep', position: { x: col * 210, y: (cols[col] - 1) * 86 }, data: n }
    })
    return { nodes: nodes.sort((a, b) => ORDER.indexOf((a.data as { kind: string }).kind) - ORDER.indexOf((b.data as { kind: string }).kind)), edges: deps.edges.map((e, i): Edge => ({ id: `e${i}`, ...e, animated: true })) }
  }, [deps])
  const solids = geo?.objects.filter((o) => ['cuboid', 'cylinder', 'sphere'].includes(o.kind)) ?? []
  return (
    <div className="grid gap-3 @5xl:grid-cols-[320px_minmax(0,1fr)]">
      <Panel title="Twin definition">
        <div className="space-y-2 text-xs">
          <Field label="Name"><Input className="w-full" value={twin.name} onChange={(e) => onChange({ ...twin, name: e.target.value })} /></Field>
          <Field label="Geometry (solid)"><Select value={twin.geometry_object_id ?? ''} onChange={(e) => { const o = geo?.objects.find((x) => x.id === e.target.value); onChange({ ...twin, geometry_object_id: e.target.value || null, material: twin.material ?? o?.material ?? null }) }}><option value="">— select —</option>{solids.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}</Select></Field>
          <Field label="Material">
            <Select value={twin.material ? `${twin.material.type}:${twin.material.id}` : ''} onChange={(e) => { const [type, ...id] = e.target.value.split(':'); onChange({ ...twin, material: e.target.value ? { type: type as 'material' | 'formulation', id: id.join(':') } : null }) }}>
              <option value="">— select —</option>
              <optgroup label="Project formulations (thermal properties from composition)">{formulations.map((f) => <option key={f.id} value={`formulation:${f.id}`}>{f.name}</option>)}</optgroup>
              <optgroup label="Library materials (approved records / models)">{mats.map((m) => <option key={m.id} value={`material:${m.id}`}>{m.name}</option>)}</optgroup>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Initial temperature [°C]"><NumInput value={twin.conditions.initial_temperature} allowNull={false} onChange={(v) => onChange({ ...twin, conditions: { ...twin.conditions, initial_temperature: v ?? 20 } })} /></Field>
            <Field label="Concentration [% w/w]" hint="used to select rheology models"><NumInput value={twin.conditions.concentration} onChange={(v) => onChange({ ...twin, conditions: { ...twin.conditions, concentration: v } })} /></Field>
          </div>
          <Button size="sm" onClick={() => nav('/geometry')}>Edit geometry</Button>
        </div>
      </Panel>
      <Panel title="Model dependencies & provenance" subtitle="Papers → approved records/models → material → twin → study → results → validation (from the latest study).">
        <div className="h-[380px] rounded border border-neutral-200 dark:border-white/10">
          <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={{ dep: DepNode }} fitView proOptions={{ hideAttribution: true }} nodesDraggable colorMode={dark ? 'dark' : 'light'}>
            <Background gap={16} size={1} /><Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {!hasStudy && <p className="mt-1 text-[11px] text-neutral-500">Run a study to populate the model and source nodes.</p>}
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ Physics tab
function PhysicsTab({ twin, obj, mats, onChange }: { twin: Twin; obj: GeoObject | null; mats: Material[]; onChange: (t: Twin) => void }) {
  const [tags, setTags] = useState<string[]>([])
  const [rheo, setRheo] = useState<{ models: { id: string; name: string; exact_conditions: boolean; conditions: Record<string, number>; status: string }[]; message: string | null } | null>(null)
  useEffect(() => { api.post<{ boundaries: string[] }>(`/api/twins/${twin.id}/mesh`).then((m) => setTags(m.boundaries)).catch(() => setTags([])) }, [twin.id, twin.geometry_object_id])  // eslint-disable-line react-hooks/exhaustive-deps
  const flowMat = twin.material?.type === 'material' ? twin.material.id : twin.flow.material_id
  useEffect(() => {
    if (!flowMat) return setRheo(null)
    const q = new URLSearchParams({ material_id: flowMat, quantity: 'rheology_hb', temperature: String(twin.flow.temperature) })
    if (twin.conditions.concentration !== null) q.set('concentration', String(twin.conditions.concentration))
    api.get<typeof rheo>(`/api/science/resolve?${q}`).then(setRheo).catch(() => setRheo(null))
  }, [flowMat, twin.flow.temperature, twin.conditions.concentration])
  const on = (k: string) => twin.physics.find((p) => p.kind === k)?.enabled ?? false
  const toggle = (k: string, v: boolean) => onChange({ ...twin, physics: twin.physics.some((p) => p.kind === k) ? twin.physics.map((p) => (p.kind === k ? { ...p, enabled: v } : p)) : [...twin.physics, { kind: k, enabled: v }] })
  const bc = (tag: string) => twin.boundaries[tag] ?? twin.boundaries.default
  const setBc = (tag: string, b: BC) => onChange({ ...twin, boundaries: { ...twin.boundaries, [tag]: b } })
  return (
    <div className="grid gap-3 @4xl:grid-cols-2">
      {PHYSICS.map((p) => (
        <Panel key={p.kind} title={p.label} actions={<label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={on(p.kind)} onChange={(e) => toggle(p.kind, e.target.checked)} />enabled</label>} className={cx(!on(p.kind) && 'opacity-60')}>
          <div className="mb-2 overflow-x-auto"><Equation latex={p.eq} display /></div>
          {p.kind === 'heat' && (
            <div className="space-y-1.5 text-xs">
              <div className="text-[11px] font-medium text-neutral-500">Boundary conditions ({obj?.kind ?? 'no geometry'})</div>
              {(['default', ...tags] as string[]).map((tag) => {
                const b = bc(tag)
                const custom = tag === 'default' || !!twin.boundaries[tag]
                return (
                  <div key={tag} className="grid grid-cols-[80px_110px_1fr] items-center gap-1">
                    <span className="truncate font-mono text-[11px]">{tag === 'default' ? 'all (default)' : tag}</span>
                    <Select value={custom ? b.type : 'inherit'} onChange={(e) => { if (e.target.value === 'inherit') { const n = { ...twin.boundaries }; delete n[tag]; onChange({ ...twin, boundaries: n }) } else setBc(tag, { ...b, type: e.target.value as BC['type'] }) }}>
                      {tag !== 'default' && <option value="inherit">as default</option>}<option value="convection">convection</option><option value="temperature">fixed T</option><option value="insulated">insulated</option>
                    </Select>
                    {custom && b.type === 'convection' && <div className="flex gap-1"><NumInput value={b.h ?? 25} allowNull={false} onChange={(v) => setBc(tag, { ...b, h: v ?? 25 })} /><span className="self-center text-[10px]">W/m²K</span><NumInput value={b.T_inf ?? 90} allowNull={false} onChange={(v) => setBc(tag, { ...b, T_inf: v ?? 90 })} /><span className="self-center text-[10px]">°C</span></div>}
                    {custom && b.type === 'temperature' && <div className="flex gap-1"><NumInput value={b.value ?? 90} allowNull={false} onChange={(v) => setBc(tag, { ...b, value: v ?? 90 })} /><span className="self-center text-[10px]">°C</span></div>}
                    {(!custom || b.type === 'insulated') && <span />}
                  </div>
                )
              })}
              <p className="text-[10.5px] text-neutral-500">Heat-transfer coefficients are process inputs (not predicted). Formulation materials use temperature-dependent Choi & Okos properties; library materials use approved records.</p>
            </div>
          )}
          {p.kind === 'flow' && (
            <div className="space-y-1.5 text-xs">
              {obj?.kind !== 'cylinder' && <Alert kind="warn">Requires a cylindrical channel geometry (e.g. the extrusion die).</Alert>}
              <div className="grid grid-cols-2 gap-1.5">
                <Field label="Flow rate [mL/min]"><NumInput value={twin.flow.flow_rate_ml_min} allowNull={false} onChange={(v) => onChange({ ...twin, flow: { ...twin.flow, flow_rate_ml_min: v ?? 60 } })} /></Field>
                <Field label="Flow temperature [°C]"><NumInput value={twin.flow.temperature} allowNull={false} onChange={(v) => onChange({ ...twin, flow: { ...twin.flow, temperature: v ?? 25 } })} /></Field>
              </div>
              {twin.material?.type !== 'material' && <Field label="Material for rheology"><Select value={twin.flow.material_id ?? ''} onChange={(e) => onChange({ ...twin, flow: { ...twin.flow, material_id: e.target.value } })}><option value="">— select —</option>{mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>}
              {rheo && (rheo.models.length ? (
                <div className="rounded border border-neutral-200 p-1.5 dark:border-white/10">
                  <div className="text-[11px] font-medium text-neutral-500">Approved rheological models (ranked by condition match)</div>
                  {rheo.models.map((m, i) => <div key={m.id} className={cx('flex items-center gap-1 text-[11px]', i === 0 && 'font-semibold')}>{m.exact_conditions ? <Badge tone="green">exact</Badge> : <Badge tone="amber">nearest</Badge>}<span className="truncate">{m.name}</span></div>)}
                  {!rheo.models[0].exact_conditions && <p className="mt-1 text-[10.5px] text-amber-700 dark:text-amber-400">No model matches the requested conditions exactly; the study will refuse unless extrapolation is explicitly allowed.</p>}
                </div>
              ) : <Alert kind="warn">{rheo.message}</Alert>)}
            </div>
          )}
          {p.kind === 'diffusion' && (
            <div className="grid grid-cols-2 gap-1.5 text-xs">
              <Field label="Initial moisture [%]"><NumInput value={twin.diffusion.initial} allowNull={false} onChange={(v) => onChange({ ...twin, diffusion: { ...twin.diffusion, initial: v ?? 50 } })} /></Field>
              <Field label="Surface moisture [%]"><NumInput value={twin.diffusion.surface_value} allowNull={false} onChange={(v) => onChange({ ...twin, diffusion: { ...twin.diffusion, surface_value: v ?? 10 } })} /></Field>
              <Field label="D source"><Select value={twin.diffusion.D_source} onChange={(e) => onChange({ ...twin, diffusion: { ...twin.diffusion, D_source: e.target.value } })}><option value="library">approved library record</option><option value="manual">manual (unvalidated)</option></Select></Field>
              <Field label="D manual [m²/s]"><NumInput value={twin.diffusion.D_manual} onChange={(v) => onChange({ ...twin, diffusion: { ...twin.diffusion, D_manual: v } })} placeholder="e.g. 1e-10" /></Field>
            </div>
          )}
          {p.kind === 'kinetics' && (
            <div className="space-y-1.5 text-xs">
              <Field label="Material whose approved first-order model is used"><Select value={twin.kinetics.material_id ?? ''} onChange={(e) => onChange({ ...twin, kinetics: { ...twin.kinetics, material_id: e.target.value || null } })}><option value="">— select —</option>{mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
              <p className="text-[10.5px] text-neutral-500">Requires heat transfer. Integrated cell-wise on the computed temperature history; not reported where temperatures leave the model's validated range (unless extrapolation is allowed).</p>
            </div>
          )}
        </Panel>
      ))}
      <Inspector>
        <div className="space-y-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Validity policy</div>
          <label className="flex items-start gap-2"><input type="checkbox" checked={twin.allow_extrapolation} onChange={(e) => onChange({ ...twin, allow_extrapolation: e.target.checked })} className="mt-0.5" /><span>Allow extrapolation beyond validated ranges / conditions. Results will be flagged as <b>extrapolated</b>.</span></label>
          <p className="text-neutral-500">By default the solver refuses to evaluate models outside their validated ranges and explains which characterisation is missing.</p>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Manual property overrides (unvalidated)</div>
          {(['k', 'rho_cp'] as const).map((k) => <Field key={k} label={k === 'k' ? 'k [W/(m·K)]' : 'ρ·cp [J/(m³·K)]'}><NumInput value={twin.property_overrides[k] ?? null} onChange={(v) => { const o = { ...twin.property_overrides }; if (v === null) delete o[k]; else o[k] = v; onChange({ ...twin, property_overrides: o }) }} placeholder="from material" /></Field>)}
        </div>
      </Inspector>
    </div>
  )
}

// ------------------------------------------------------------------ Mesh tab
function MeshTab({ twin, mesh, onBuild, onChange, obj }: { twin: Twin; mesh: Record<string, unknown> | null; onBuild: () => void; onChange: (t: Twin) => void; obj: GeoObject | null }) {
  const grid = mesh?.grid as Record<string, number[]> | undefined
  const lines = useMemo(() => {
    if (!grid) return [] as { x: (number | null)[]; y: (number | null)[] }[]
    const xs = grid.x_edges ?? grid.r_edges, ys = grid.z_edges
    if (!xs) return []
    if (!ys) return [{ x: xs.flatMap((x) => [x, x, null]), y: xs.flatMap(() => [0, 1, null]) }]
    return [{ x: [...xs.flatMap((x) => [x, x, null]), ...ys.flatMap(() => [xs[0], xs[xs.length - 1], null])], y: [...xs.flatMap(() => [ys[0], ys[ys.length - 1], null]), ...ys.flatMap((y) => [y, y, null])] }]
  }, [grid])
  return (
    <div className="grid gap-3 @4xl:grid-cols-[300px_minmax(0,1fr)]">
      <Panel title="Mesh settings">
        <div className="space-y-2 text-xs">
          <div>Geometry: <b>{obj?.name ?? '—'}</b> ({obj?.kind})</div>
          <Field label="Target cell size [mm]" hint="empty = automatic"><NumInput value={twin.mesh.size_mm} onChange={(v) => onChange({ ...twin, mesh: { size_mm: v } })} placeholder="auto" /></Field>
          <Button variant="primary" onClick={onBuild}><Grid3x3 className="h-3.5 w-3.5" />Build mesh</Button>
          {mesh && <KV rows={[['Element type', String(mesh.element)], ['Cells', String(mesh.cells)], ['Layout', (mesh.shape as number[]).join(' × ')], ['Min cell', `${fmtSci(mesh.min_cell_mm as number, 3)} mm`], ['Max cell', `${fmtSci(mesh.max_cell_mm as number, 3)} mm`], ['Max aspect ratio', fmtSci(mesh.max_aspect_ratio as number, 3)], ['Quality', String(mesh.quality)], ['Boundaries', (mesh.boundaries as string[]).join(', ')]]} />}
          <Alert>Structured finite-volume meshes: hexahedral cells for cuboids, axisymmetric (r, z) annular cells for cylinders and radial shells for spheres. Arbitrary 3-D (e.g. STL) geometries are not meshed — no general 3-D FEM solver is claimed.</Alert>
        </div>
      </Panel>
      <Panel title={mesh ? `Mesh preview — ${String(mesh.type) === 'cartesian3d' ? 'x–z section' : 'r–z section'}` : 'Mesh preview'}>
        {mesh ? <Plot height={360} data={lines.map((l) => ({ type: 'scatter' as const, mode: 'lines' as const, x: l.x, y: l.y, line: { color: '#e11d48', width: 1 }, hoverinfo: 'skip' as const, showlegend: false }))} layout={{ xaxis: { title: { text: grid?.x_edges ? 'x [mm]' : 'r [mm]' }, scaleanchor: 'y' }, yaxis: { title: { text: 'z [mm]' } }, margin: { l: 50, r: 10, t: 10, b: 40 } }} />
          : <p className="py-10 text-center text-xs text-neutral-500">Build the mesh to inspect cell counts and quality.</p>}
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ Study tab
function StudyTab({ twin, onChange, onRun }: { twin: Twin; onChange: (t: Twin) => void; onRun: () => void }) {
  const s = twin.study
  const set = (p: Partial<Twin['study']>) => onChange({ ...twin, study: { ...s, ...p } })
  return (
    <div className="grid gap-3 @4xl:grid-cols-2">
      <Panel title="Study configuration">
        <div className="space-y-2 text-xs">
          <Field label="Study type">
            <Select value={s.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="time">Time-dependent</option><option value="stationary">Stationary (steady state)</option><option value="sweep">Parametric sweep (time-dependent)</option><option value="sensitivity">Sensitivity study (one-at-a-time)</option>
            </Select>
          </Field>
          {s.type !== 'stationary' && (
            <div className="grid grid-cols-3 gap-1.5">
              <Field label="End time [s]"><NumInput value={s.t_end} allowNull={false} onChange={(v) => set({ t_end: Math.max(1, v ?? 600) })} /></Field>
              <Field label="Time step [s]"><NumInput value={s.dt} allowNull={false} onChange={(v) => set({ dt: Math.max(0.01, v ?? 5) })} /></Field>
              <Field label="Stored frames"><NumInput value={s.frames} allowNull={false} onChange={(v) => set({ frames: Math.max(2, Math.min(80, Math.round(v ?? 30))) })} /></Field>
            </div>
          )}
          {s.type === 'sweep' && (
            <div className="grid grid-cols-2 gap-1.5">
              <Field label="Parameter"><Select value={s.sweep.parameter} onChange={(e) => set({ sweep: { ...s.sweep, parameter: e.target.value } })}><option value="boundary_h">heat-transfer coefficient h [W/m²K]</option><option value="ambient_temperature">ambient / wall temperature [°C]</option><option value="initial_temperature">initial temperature [°C]</option><option value="t_end">process time [s]</option></Select></Field>
              <Field label="Values (comma separated)"><Input className="w-full" defaultValue={s.sweep.values.join(', ')} onBlur={(e) => set({ sweep: { ...s.sweep, values: e.target.value.split(',').map(Number).filter(Number.isFinite) } })} /></Field>
            </div>
          )}
          {s.type === 'sensitivity' && <Field label="Relative perturbation"><NumInput value={s.sensitivity.delta} allowNull={false} onChange={(v) => set({ sensitivity: { delta: v ?? 0.1 } })} /></Field>}
          <div className="text-[11px] text-neutral-500">Backward-Euler time integration (unconditionally stable; first-order accurate in time). Flow physics is solved as a stationary, fully developed problem.</div>
          <Button variant="primary" onClick={onRun}><Play className="h-3.5 w-3.5" />Compute (F5)</Button>
        </div>
      </Panel>
      <Panel title="Solver verification">
        <div className="space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          <p>The conduction solver is verified in the test-suite against the exact series solution for a plane wall with convective boundaries (Bi = 0.5, Fo = 3): centre temperature error &lt; 0.1 %.</p>
          <p>Energy balance: boundary heat input equals stored energy to round-off (reported in each study log).</p>
          <p>The Herschel–Bulkley channel solution reproduces the imposed flow rate by quadrature of the velocity profile (reported as “flow rate (numerical)”).</p>
        </div>
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ Results tab
const CS = [[0, '#1e1b4b'], [0.25, '#2563eb'], [0.5, '#22d3ee'], [0.75, '#fbbf24'], [1, '#e11d48']]

function FieldSection({ obj, view, frame, unit, zmin, zmax }: { obj: GeoObject; view: View; frame: (number | null)[][]; unit: string; zmin: number; zmax: number }) {
  const geom = useMemo(() => buildGeometry(obj), [obj])
  const plane = useMemo(() => {
    const nx = view.x.length, ny = view.y.length
    const g = new THREE.PlaneGeometry(1, 1, nx - 1, ny - 1)
    const pos = g.getAttribute('position')
    const colors = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const stops = CS.map(([t, h]) => [t as number, new THREE.Color(h as string)] as const)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      pos.setXYZ(k, view.x[i], 0, view.y[ny - 1 - j] - (obj.kind === 'cuboid' ? obj.dims.height / 2 : obj.dims.height / 2))
      const v = frame[ny - 1 - j]?.[i]
      const t = v === null || v === undefined ? 0 : Math.min(1, Math.max(0, (v - zmin) / Math.max(zmax - zmin, 1e-12)))
      let s = 0
      while (s < stops.length - 2 && t > stops[s + 1][0]) s++
      const [t0, c0] = stops[s], [t1, c1] = stops[s + 1]
      c.copy(c0).lerp(c1, (t - t0) / (t1 - t0))
      colors.set([c.r, c.g, c.b], k * 3)
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeVertexNormals()
    return g
  }, [view, frame, zmin, zmax, obj])
  const m = objectMatrix(obj)
  void unit
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <group matrixAutoUpdate={false} matrix={m}>
        {geom && <mesh geometry={geom}><meshStandardMaterial color="#9ca3af" transparent opacity={0.18} depthWrite={false} userData={{ baseTransparent: true, baseOpacity: 0.18 }} /></mesh>}
        {geom && <lineSegments geometry={new THREE.EdgesGeometry(geom, 25)} userData={{ noViewMode: true }}><lineBasicMaterial color="#525252" /></lineSegments>}
        <mesh geometry={plane} rotation={obj.kind === 'cylinder' ? [0, 0, 0] : [0, 0, 0]} userData={{ noViewMode: true }}><meshBasicMaterial vertexColors side={THREE.DoubleSide} /></mesh>
      </group>
    </group>
  )
}

function ResultsTab({ study, studies, obj, onSelect, onDelete, onCompared }: { study: Study | null; studies: Study[]; obj: GeoObject | null; onSelect: (id: string) => void; onDelete: (id: string) => void; onCompared: (s: Study) => void }) {
  const fields = useMemo(() => {
    const f: { key: string; label: string; res: FieldRes }[] = []
    if (study?.heat?.views || study?.heat?.profile) f.push({ key: 'heat', label: 'Temperature [°C]', res: study.heat })
    if (study?.diffusion) f.push({ key: 'diffusion', label: `Moisture [${study.diffusion.unit}]`, res: study.diffusion })
    return f
  }, [study])
  const [fk, setFk] = useState('heat')
  const field = fields.find((f) => f.key === fk) ?? fields[0]
  const views = field?.res.views ?? {}
  const [vk, setVk] = useState<string>('')
  const vkey = views[vk] ? vk : Object.keys(views)[0]
  const view = views[vkey]
  const [fi, setFi] = useState(0)
  const [playing, setPlaying] = useState(false)
  const nF = field?.res.times.length ?? 0
  useEffect(() => { setFi(Math.max(0, nF - 1)) }, [study?.id, fk, nF])
  useEffect(() => {
    if (!playing) return
    const h = setInterval(() => setFi((i) => (i + 1 >= nF ? (setPlaying(false), nF - 1) : i + 1)), 220)
    return () => clearInterval(h)
  }, [playing, nF])
  const range = useMemo(() => {
    if (!view) return [0, 1]
    let lo = Infinity, hi = -Infinity
    view.frames.forEach((fr) => fr.forEach((row) => row.forEach((v) => { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v) } })))
    return [lo, hi]
  }, [view])
  const [flowField, setFlowField] = useState('velocity [m/s]')
  const [cmp, setCmp] = useState({ probe: 'centre', text: '', label: 'Thermocouple (lab)' })
  const { toast } = useStore()
  if (!study) return <Panel><p className="py-10 text-center text-sm text-neutral-500">No results yet. Configure physics and press Compute (F5).</p></Panel>
  const t = field?.res.times[fi]
  const runCompare = async () => {
    const data = cmp.text.split('\n').map((l) => l.split(/[,;\t ]+/).map(Number)).filter((r) => r.length >= 2 && r.every(Number.isFinite)).map((r) => [r[0], r[1]])
    if (data.length < 2) return toast('Enter at least two rows: time [s], measured value', 'error')
    try {
      await api.post(`/api/studies/${study.id}/compare`, { probe: cmp.probe, data, label: cmp.label, field: field?.key ?? 'heat' })
      onCompared(await api.get<Study>(`/api/studies/${study.id}`))
      log('info', 'validation', `Compared ${study.name} with ${cmp.label}`)
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const val = study.validation?.metrics
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select className="w-72" value={study.id} onChange={(e) => onSelect(e.target.value)}>{studies.slice().reverse().map((s) => <option key={s.id} value={s.id}>{new Date(s.created).toLocaleString()} — {s.type}{s.extrapolated ? ' (extrapolated)' : ''}</option>)}</Select>
        <Button size="sm" onClick={() => exportStudy(study)}><Download className="h-3.5 w-3.5" />Export CSV + JSON</Button>
        <Button size="sm" variant="ghost" onClick={() => onDelete(study.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
        {study.extrapolated ? <Badge tone="red">contains extrapolation</Badge> : <Badge tone="green">within validated ranges</Badge>}
        <Prov kind="predicted" />
      </div>
      {study.warnings.map((w, i) => <Alert key={i} kind={w.startsWith('EXTRAPOLATION') ? 'error' : 'warn'}>{w}</Alert>)}

      {field && view && (
        <div className="grid gap-3 @5xl:grid-cols-2">
          <Panel title={`${field.label} — ${vkey}`} actions={<>
            {fields.length > 1 && <Select className="w-32" value={field.key} onChange={(e) => setFk(e.target.value)}>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>}
            {Object.keys(views).length > 1 && <Select className="w-44" value={vkey} onChange={(e) => setVk(e.target.value)}>{Object.keys(views).map((k) => <option key={k}>{k}</option>)}</Select>}
          </>}>
            <Plot height={300} data={[{ type: 'heatmap', x: view.x, y: view.y, z: view.frames[fi], zmin: range[0], zmax: range[1], colorscale: CS as unknown as string, colorbar: { title: { text: field.res.unit }, thickness: 12 }, zsmooth: 'best' }, { type: 'contour', x: view.x, y: view.y, z: view.frames[fi], showscale: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: '#fff' } }, line: { color: 'rgba(255,255,255,0.6)', width: 1 }, ncontours: 8, hoverinfo: 'skip' }]}
              layout={{ xaxis: { title: { text: view.xlabel }, scaleanchor: 'y' }, yaxis: { title: { text: view.ylabel } }, margin: { l: 50, r: 10, t: 10, b: 40 } }} />
            <div className="mt-1 flex items-center gap-2 text-xs">
              <Button size="sm" onClick={() => { if (fi >= nF - 1) setFi(0); setPlaying(!playing) }}>{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
              <input type="range" min={0} max={Math.max(0, nF - 1)} value={fi} onChange={(e) => setFi(Number(e.target.value))} className="flex-1" aria-label="Time step" />
              <span className="num w-24 text-right">t = {t === null || t === undefined ? 'steady' : `${fmtSci(t, 4)} s`}</span>
            </div>
          </Panel>
          <Panel title="3D view — computed field on the section plane">
            <div className="h-[340px]">
              {obj && ['cuboid', 'cylinder'].includes(obj.kind) ? (
                <GraphicsView gridSize={200} showGizmo={false} legend={<div className="flex items-center gap-1 rounded bg-white/90 px-2 py-1 text-[10px] dark:bg-neutral-900/90"><span>{fmtSci(range[0], 3)}</span><span className="h-2 w-28 rounded" style={{ background: `linear-gradient(90deg, ${CS.map((c) => c[1]).join(',')})` }} /><span>{fmtSci(range[1], 3)} {field.res.unit}</span></div>}>
                  <FieldSection obj={obj} view={view} frame={view.frames[fi]} unit={field.res.unit} zmin={range[0]} zmax={range[1]} />
                </GraphicsView>
              ) : <p className="text-xs text-neutral-500">3D section rendering is available for cuboid and cylinder twins.</p>}
            </div>
          </Panel>
        </div>
      )}
      {field?.res.profile && (
        <Panel title={`${field.label} — radial profiles`}>
          <Plot height={280} data={field.res.profile.frames.filter((_, i) => i % Math.max(1, Math.floor(field.res.profile!.frames.length / 6)) === 0).map((f, i) => ({ type: 'scatter' as const, mode: 'lines' as const, x: field.res.profile!.r, y: f, name: `frame ${i}` }))} layout={{ xaxis: { title: { text: 'r [mm]' } }, yaxis: { title: { text: field.res.unit } } }} />
        </Panel>
      )}
      {field && (
        <div className="grid gap-3 @5xl:grid-cols-2">
          <Panel title="Probe histories">
            <Plot height={260} data={[...Object.entries(field.res.probes).map(([k, v]) => ({ type: 'scatter' as const, mode: 'lines' as const, name: k, x: field.res.times.map((x) => x ?? 0), y: v })), { type: 'scatter' as const, mode: 'lines' as const, name: 'volume mean', x: field.res.times.map((x) => x ?? 0), y: field.res.mean, line: { dash: 'dot' } },
              ...(val && val.probe !== 'mean' ? [{ type: 'scatter' as const, mode: 'markers' as const, name: `measured (${val.label})`, x: val.points.map((p) => p.t), y: val.points.map((p) => p.observed), marker: { color: '#111827', symbol: 'x' as const, size: 8 } }] : [])]}
              layout={{ xaxis: { title: { text: 'time [s]' } }, yaxis: { title: { text: field.res.unit } } }} />
            {field.res.balance && <p className="text-[10.5px] text-neutral-500">Energy balance: boundary input vs stored energy, relative error {field.res.balance.relative_error.toExponential(2)}.</p>}
          </Panel>
          <Panel title="Compare with experimental data">
            <div className="grid grid-cols-2 gap-1.5 text-xs">
              <Field label="Probe"><Select value={cmp.probe} onChange={(e) => setCmp({ ...cmp, probe: e.target.value })}>{[...Object.keys(field.res.probes), 'mean'].map((p) => <option key={p}>{p}</option>)}</Select></Field>
              <Field label="Dataset label"><Input className="w-full" value={cmp.label} onChange={(e) => setCmp({ ...cmp, label: e.target.value })} /></Field>
              <Field label={`time [s], measured [${field.res.unit}] — one row per line`} className="col-span-2"><textarea className={cx(inputCls, 'h-16 w-full py-1 font-mono text-[11px]')} value={cmp.text} onChange={(e) => setCmp({ ...cmp, text: e.target.value })} placeholder={'0, 20\n300, 55\n600, 71'} /></Field>
            </div>
            <Button size="sm" className="mt-1" onClick={runCompare}>Compare</Button>
            {val && (
              <div className="mt-2 grid grid-cols-[1fr_150px] gap-2">
                <Plot height={170} data={[{ type: 'bar', x: val.points.map((p) => p.t), y: val.points.map((p) => p.predicted - p.observed), marker: { color: '#e11d48' }, name: 'residual' }]} layout={{ showlegend: false, xaxis: { title: { text: 'time [s]' } }, yaxis: { title: { text: `pred − obs [${field.res.unit}]` } }, margin: { l: 50, r: 6, t: 6, b: 36 } }} />
                <div className="text-xs"><div className="font-semibold">{val.label}</div><div>probe: {val.probe}, n = {val.n}</div><div>RMSE = {fmtSci(val.rmse, 4)}</div><div>bias = {fmtSci(val.bias, 4)}</div><div>MAE = {fmtSci(val.mae, 4)}</div><div>max |err| = {fmtSci(val.max_abs_error, 4)}</div><div>R² = {fmtSci(val.r2, 3)}</div></div>
              </div>
            )}
          </Panel>
        </div>
      )}
      {study.reaction && (
        <Panel title="Reaction progress — native (undenatured) fraction at t_end" actions={<Badge tone="green">approved kinetic model</Badge>}>
          {Object.entries(study.reaction.views ?? {}).slice(0, 1).map(([k, v]) => (
            <Plot key={k} height={240} data={[{ type: 'heatmap', x: v.x, y: v.y, z: v.frames[0], zmin: 0, zmax: 1, colorscale: 'Viridis', colorbar: { title: { text: '1 − X' }, thickness: 12 } }]} layout={{ xaxis: { title: { text: v.xlabel }, scaleanchor: 'y' }, yaxis: { title: { text: v.ylabel } }, margin: { l: 50, r: 10, t: 10, b: 40 } }} />
          ))}
          <p className="text-xs">Volume-mean native fraction {fmtSci(study.reaction.mean, 4)}; centre {fmtSci(study.reaction.centre, 4)}.</p>
        </Panel>
      )}
      {study.flow && (
        <div className="grid gap-3 @5xl:grid-cols-2">
          <Panel title="Flow profiles (fully developed, Herschel–Bulkley)">
            <Plot height={280} data={[
              { type: 'scatter', mode: 'lines', name: 'velocity [m/s]', x: study.flow.r_mm, y: study.flow.velocity_m_s },
              { type: 'scatter', mode: 'lines', name: 'shear rate [1/s]', x: study.flow.r_mm, y: study.flow.shear_rate_1_s, yaxis: 'y2' },
              { type: 'scatter', mode: 'lines', name: 'apparent viscosity [Pa·s]', x: study.flow.r_mm, y: study.flow.apparent_viscosity_pa_s, yaxis: 'y2', line: { dash: 'dot' } },
            ]} layout={{ xaxis: { title: { text: 'r [mm]' } }, yaxis: { title: { text: 'velocity [m/s]' } }, yaxis2: { overlaying: 'y', side: 'right', type: 'log', title: { text: 'shear rate / viscosity' } }, margin: { l: 56, r: 56, t: 10, b: 64 } }} />
            <KV rows={[['Pressure drop ΔP', `${fmtSci(study.flow.pressure_drop_pa, 5)} Pa`], ['Wall shear stress', `${fmtSci(study.flow.wall_shear_stress_pa, 4)} Pa`], ['Wall shear rate', `${fmtSci(study.flow.wall_shear_rate_1_s, 4)} 1/s`], ['Plug radius', `${fmtSci(study.flow.plug_radius_mm, 4)} mm`], ['Mean / max velocity', `${fmtSci(study.flow.mean_velocity_m_s, 4)} / ${fmtSci(study.flow.max_velocity_m_s, 4)} m/s`], ['Flow rate (numerical check)', `${fmtSci(study.flow.flow_rate_m3_s * 6e7, 5)} mL/min`], ['HB parameters', `τ₀ ${study.flow.hb.yield_stress_pa} Pa, K ${study.flow.hb.consistency_index_pa_sn}, n ${study.flow.hb.flow_behaviour_index}`]]} />
          </Panel>
          <Panel title="Section field" actions={<Select className="w-48" value={flowField} onChange={(e) => setFlowField(e.target.value)}>{Object.keys(study.flow.section.fields).map((k) => <option key={k}>{k}</option>)}</Select>}>
            <Plot height={320} data={[{ type: 'heatmap', x: study.flow.section.x, y: study.flow.section.y, z: study.flow.section.fields[flowField], colorscale: CS as unknown as string, colorbar: { title: { text: flowField.split(' ').pop() ?? '' }, thickness: 12 } }]} layout={{ xaxis: { title: { text: study.flow.section.xlabel } }, yaxis: { title: { text: study.flow.section.ylabel } }, margin: { l: 50, r: 10, t: 10, b: 40 } }} />
          </Panel>
        </div>
      )}
      {study.sweep && (
        <Panel title={`Parametric sweep — ${study.sweep.parameter}`}>
          <Plot height={260} data={['final_centre_C', 'final_mean_C', 'final_min_C'].map((k) => ({ type: 'scatter' as const, mode: 'lines+markers' as const, name: k.replace(/_/g, ' '), x: study.sweep!.rows.map((r) => r.value), y: study.sweep!.rows.map((r) => r[k]) }))} layout={{ xaxis: { title: { text: study.sweep.parameter } }, yaxis: { title: { text: '°C at t_end' } } }} />
        </Panel>
      )}
      {study.sensitivity && (
        <Panel title="Sensitivity study" subtitle={study.sensitivity.note}>
          <Plot height={220} data={[{ type: 'bar', orientation: 'h', y: study.sensitivity.rows.map((r) => r.parameter), x: study.sensitivity.rows.map((r) => r.normalised_sensitivity ?? 0), marker: { color: '#0891b2' } }]} layout={{ xaxis: { title: { text: `normalised sensitivity of ${study.sensitivity.metric}` } }, margin: { l: 190, r: 10, t: 10, b: 44 } }} />
        </Panel>
      )}
      <div className="grid gap-3 @5xl:grid-cols-2">
        <Panel title="Input provenance">
          <table className="w-full text-xs"><tbody>{study.provenance.map((p, i) => <tr key={i} className="border-t border-neutral-100 align-top dark:border-white/5"><td className="py-1 pr-2 font-medium">{p.quantity}</td><td className="pr-2">{p.model ?? p.source}{p.page ? `, p. ${p.page}` : ''}{p.value !== undefined ? ` — ${fmtSci(p.value, 4)} ${p.unit ?? ''}` : ''}</td><td><Badge tone={p.type.includes('approved') ? 'green' : p.type.includes('user') ? 'amber' : 'neutral'}>{p.type}</Badge></td></tr>)}</tbody></table>
        </Panel>
        <Panel title="Solver log">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{study.log.join('\n')}</pre>
          {study.mesh && <p className="mt-1 text-[11px] text-neutral-500">Mesh: {String(study.mesh.cells)} cells, {String(study.mesh.element)}, max aspect ratio {fmtSci(study.mesh.max_aspect_ratio as number, 3)}</p>}
        </Panel>
      </div>
    </div>
  )
}
