import { Boxes, ExternalLink, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Equation } from '../components/Equation'
import { GraphicsView } from '../components/GraphicsView'
import { Plot } from '../components/Plot'
import { Legend, SEGMENT_COLORS, TwinField, TwinMeshLines, cellCentres, type MeshInfo } from '../components/TwinScene'
import { Alert, Badge, Button, Field, Input, KV, NumInput, PageHeader, Select, Tabs, cx } from '../components/ui'
import { api, download } from '../lib/api'
import { unitLabel } from '../lib/sci'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector, PlotsSlot, ResultsSlot, useEquations } from '../workspace/Slots'
import { log, useWs } from '../workspace/wsStore'

/* ------------------------------------------------------------------ types */
type Dict = Record<string, unknown>
type BC = { type: string; [k: string]: unknown }
interface Physics { id: string; kind: 'heat' | 'flow' | 'structural' | 'diffusion'; label: string; enabled: boolean; settings: Dict; bcs: Record<string, BC> }
interface Twin {
  id: string; name: string; project_id: string | null
  geometry: { shape: string; params: Dict; depth: number }
  mesh: { level: string; cells_across?: number | null }
  material: { material_id: string | null; sources: Record<string, Dict> }
  conditions: { temperature_c: number }
  physics: Physics[]
}
interface Catalogue {
  shapes: Record<string, { label: string; params: Dict }>
  mesh_levels: Record<string, number>
  physics: Record<string, { label: string; equation: string }>
  kinetics_equation: string
}
interface Segment { id: string; label: string; faces: number }
interface MeshFull extends MeshInfo { boundary_faces: Record<string, number>; segments: Segment[]; boundary_cells: Record<string, number[]>; exact_area_mm2: number; meshed_area_mm2: number; area_error_pct: number; nodes: number }
interface Preview { mesh: MeshFull; geometry: { area_mm2: number; perimeter_mm: number; hydraulic_diameter_mm: number; depth_mm: number } }
interface SourceRef { paper_id?: string; page?: number; title?: string; citation?: string; synthetic?: boolean }
interface Cand { kind: string; id: string; value?: number; unit?: string; status: string; conditions?: Dict; source?: SourceRef | null; name?: string; evidence_type?: string }
interface Resolved {
  quantity: string; label: string; value: number | Dict | null; unit?: string; origin: string | null; flags: string[]; message?: string; required: boolean
  source?: SourceRef | null; conditions?: Dict; candidates?: Cand[]; models?: Cand[]; method?: string; name?: string
}
interface Inputs { material_id: string | null; quantities: Record<string, Resolved>; missing: string[]; ready: boolean }
interface Job { id: string; status: string; progress: number; log: { t: string; level: string; msg: string }[]; error?: string; result?: { study_id: string } }
interface StudyRes { kind: string; label: string; [k: string]: unknown }
interface Study { id: string; name: string; created: string; elapsed_s: number; mesh: MeshFull; inputs: Inputs; results: Record<string, StudyRes>; warnings: string[]; twin_snapshot: Twin }
interface StudyRow { id: string; name: string; created: string; elapsed_s: number; physics: string[]; cells: number }
type Tab = 'geometry' | 'material' | 'physics' | 'mesh' | 'study' | 'results'

const BC_TYPES: Record<string, { id: string; label: string; fields: [string, string][] }[]> = {
  heat: [
    { id: 'temperature', label: 'Temperature', fields: [['value', 'T [°C]']] },
    { id: 'convection', label: 'Convection', fields: [['h', 'h [W/(m²·K)]'], ['ambient', 'T∞ [°C]']] },
    { id: 'flux', label: 'Heat flux', fields: [['flux', 'q [W/m²] (into body)']] },
    { id: 'insulated', label: 'Insulated / symmetry', fields: [] },
  ],
  diffusion: [
    { id: 'concentration', label: 'Concentration', fields: [['value', 'c']] },
    { id: 'mass_transfer', label: 'Mass transfer', fields: [['km', 'kₘ [m/s]'], ['ambient', 'c∞']] },
    { id: 'flux', label: 'Flux', fields: [['flux', 'J (into body)']] },
    { id: 'impermeable', label: 'Impermeable / symmetry', fields: [] },
  ],
  structural: [
    { id: 'free', label: 'Free', fields: [] },
    { id: 'fixed', label: 'Fixed', fields: [] },
    { id: 'roller', label: 'Roller (normal fixed)', fields: [] },
    { id: 'pressure', label: 'Pressure load', fields: [['pressure', 'p [Pa] (compressive)']] },
  ],
  flow: [{ id: 'no_slip', label: 'Wall (no slip)', fields: [] }],
}
const PARAM_LABEL: Record<string, string> = { width: 'Width', height: 'Height', diameter: 'Diameter', outer_diameter: 'Outer diameter', inner_diameter: 'Inner diameter', cut_width: 'Cut-out width', cut_height: 'Cut-out height', points: 'Points' }
const THERMAL = ['thermal_conductivity', 'density', 'specific_heat']

/* ------------------------------------------------------------------ helpers */
const fmt = (v: unknown, d = 4) => {
  if (v === null || v === undefined || typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  return a !== 0 && (a >= 1e5 || a < 1e-3) ? v.toExponential(d - 1) : (+v.toPrecision(d)).toString()
}
function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}
function valueText(r: Resolved) {
  if (r.value === null || r.value === undefined) return '—'
  if (typeof r.value === 'number') return `${fmt(r.value)} ${unitLabel(r.unit)}`
  const v = r.value as Record<string, number>
  if (r.quantity === 'rheology') return `τ₀ = ${fmt(v.tau0)} Pa, K = ${fmt(v.K)} Pa·sⁿ, n = ${fmt(v.n)}`
  if (r.quantity === 'kinetics') return `k_ref = ${fmt(v.k_ref)} 1/s at ${fmt(v.T_ref_c)} °C, Eₐ = ${fmt(v.Ea / 1000)} kJ/mol`
  return JSON.stringify(v)
}

/* ------------------------------------------------------------------ page */
export default function TwinPage() {
  const [params, setParams] = useSearchParams()
  const projectId = useStore((s) => s.projectId)
  const toast = useStore((s) => s.toast)
  const select = useWs((s) => s.select)
  const setBottomTab = useWs((s) => s.setBottomTab)
  const [cat, setCat] = useState<Catalogue | null>(null)
  const [list, setList] = useState<Twin[]>([])
  const [twin, setTwin] = useState<Twin | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [inputs, setInputs] = useState<Inputs | null>(null)
  const [materials, setMaterials] = useState<{ id: string; name: string }[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [studies, setStudies] = useState<StudyRow[]>([])
  const [study, setStudy] = useState<Study | null>(null)
  const tab = (params.get('tab') as Tab) || 'geometry'
  const tid = params.get('twin')
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }) }
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadList = useCallback(() => api.get<Twin[]>(`/api/twins?project_id=${projectId ?? ''}`).then((l) => {
    setList(l)
    if (!tid && l[0]) { const p = new URLSearchParams(params); p.set('twin', l[0].id); setParams(p, { replace: true }) }
    return l
  }), [projectId, tid])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get<Catalogue>('/api/twins/catalogue').then(setCat)
    api.get<{ id: string; name: string }[]>('/api/materials').then((m) => setMaterials(m.map((x) => ({ id: x.id, name: x.name }))))
  }, [])
  useEffect(() => { loadList() }, [loadList])
  useEffect(() => {
    if (!tid) { setTwin(null); return }
    api.get<Twin>(`/api/twins/${tid}`).then((t) => { setTwin(t); select({ kind: 'twin', id: t.id, label: t.name }) }).catch(() => setTwin(null))
    api.get<StudyRow[]>(`/api/twins/${tid}/studies`).then((s) => {
      setStudies(s)
      if (s[0]) api.get<Study>(`/api/studies/${s[0].id}`).then(setStudy)
      else setStudy(null)
    })
  }, [tid, select])

  // persist edits (debounced) and refresh the derived data
  const update = (patch: Partial<Twin>) => {
    if (!twin) return
    const t = { ...twin, ...patch }
    setTwin(t)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      api.put<Twin>(`/api/twins/${t.id}`, t).then(() => { refreshInputs(t.id); if (patch.name || patch.physics) { loadList(); refreshTree() } }).catch(() => undefined)
    }, 400)
  }
  const refreshInputs = (id: string) => api.get<Inputs>(`/api/twins/${id}/inputs`).then(setInputs).catch(() => setInputs(null))
  useEffect(() => { if (twin?.id) refreshInputs(twin.id) }, [twin?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const geomKey = useDebounced(twin ? JSON.stringify({ geometry: twin.geometry, mesh: twin.mesh }) : '')
  useEffect(() => {
    if (!geomKey) return
    api.post<Preview>('/api/twins/preview-mesh', JSON.parse(geomKey)).then((p) => { setPreview(p); setPreviewErr(null) }).catch((e) => setPreviewErr((e as Error).message))
  }, [geomKey])

  const create = async (physics: string[] = ['heat']) => {
    const t = await api.post<Twin>('/api/twins', { project_id: projectId, name: `Digital twin ${list.length + 1}`, physics })
    await loadList()
    refreshTree()
    const p = new URLSearchParams(params)
    p.set('twin', t.id)
    p.set('tab', 'geometry')
    setParams(p)
    log('info', 'twin', `Created ${t.name}`)
  }
  const demo = async () => {
    const r = await api.post<{ twins: string[]; approved: number; note: string }>('/api/twins/demo', { project_id: projectId })
    await loadList()
    refreshTree()
    toast(`${r.twins.length} demo twins created (${r.approved} synthetic records approved). ${r.note}`, 'success')
    const p = new URLSearchParams(params)
    p.set('twin', r.twins[0])
    p.set('tab', 'study')
    setParams(p)
  }
  const remove = async () => {
    if (!twin || !confirm(`Delete digital twin '${twin.name}' and its studies?`)) return
    await api.del(`/api/twins/${twin.id}`)
    const l = await loadList()
    refreshTree()
    const p = new URLSearchParams(params)
    if (l.length) p.set('twin', l.find((x) => x.id !== twin.id)?.id ?? '')
    else p.delete('twin')
    setParams(p)
  }
  const addPhysics = (kind: string) => {
    if (!twin) return
    if (kind === 'kinetics') {
      const heat = twin.physics.find((p) => p.kind === 'heat')
      if (!heat) { api.post<Twin>(`/api/twins/${twin.id}/physics`, { kind: 'heat' }).then((t) => { t.physics[t.physics.length - 1].settings.kinetics = { enabled: true }; update({ physics: t.physics }) }); return }
      update({ physics: twin.physics.map((p) => (p === heat ? { ...p, settings: { ...p.settings, kinetics: { enabled: true } } } : p)) })
      toast('Reaction kinetics coupled to heat transfer', 'success')
      return
    }
    api.post<Twin>(`/api/twins/${twin.id}/physics`, { kind }).then((t) => { setTwin(t); refreshInputs(t.id); refreshTree(); setTab('physics') })
  }

  // -------- study execution (background job + solver log)
  const logIdx = useRef(0)
  const compute = async () => {
    if (!twin) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); await api.put(`/api/twins/${twin.id}`, twin) }
    setBottomTab('log')
    logIdx.current = 0
    const j = await api.post<Job>(`/api/twins/${twin.id}/studies`)
    setJob(j)
    log('info', 'study', `Started study for ${twin.name} (background job ${j.id})`)
  }
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return
    const t = setInterval(async () => {
      const j = await api.get<Job>(`/api/jobs/${job.id}`, true).catch(() => null)
      if (!j) return
      j.log.slice(logIdx.current).forEach((l) => log(l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'info', 'solver', l.msg))
      logIdx.current = j.log.length
      setJob(j)
      if (j.status === 'done' && j.result) {
        const s = await api.get<Study>(`/api/studies/${j.result.study_id}`)
        setStudy(s)
        api.get<StudyRow[]>(`/api/twins/${s.twin_snapshot && twin ? twin.id : ''}/studies`).then(setStudies).catch(() => undefined)
        log('success', 'study', `Study finished in ${s.elapsed_s} s`)
        s.warnings.forEach((w) => log('warn', 'study', w))
        setTab('results')
      } else if (j.status === 'failed') {
        toast(j.error ?? 'Study failed', 'error')
      }
    }, 400)
    return () => clearInterval(t)
  }, [job?.id, job?.status])  // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = () => job && api.post(`/api/jobs/${job.id}/cancel`)

  useCommand('twin.new', () => create())
  useCommand('twin.addPhysics', (p) => addPhysics(String(p)))
  useCommand('mesh.build', () => { setTab('mesh'); if (geomKey) api.post<Preview>('/api/twins/preview-mesh', JSON.parse(geomKey)).then(setPreview) })
  useCommand('study.compute', () => compute())
  useCommand('results.export', () => study && download(`${study.name.replace(/[^\w-]+/g, '_')}.json`, JSON.stringify(study, null, 1)))

  // equations of the enabled physics
  useEquations((twin?.physics ?? []).filter((p) => p.enabled).flatMap((p) => [
    { title: p.label, latex: cat?.physics[p.kind]?.equation ?? '', note: p.kind === 'flow' ? 'Fully developed laminar flow; w = axial velocity, G = −dp/dz' : p.kind === 'structural' ? `Plane ${p.settings.plane ?? 'stress'}, small strains` : 'Cell-centred finite volumes, implicit Euler' },
    ...(p.kind === 'heat' && (p.settings.kinetics as Dict | undefined)?.enabled ? [{ title: 'Reaction kinetics (coupled)', latex: cat?.kinetics_equation ?? '' }] : []),
  ]), [twin?.physics, cat])

  if (!cat) return <PageHeader title="Digital twin" subtitle="Loading…" />

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Digital twin" subtitle="2-D cross-section models solved with NumPy/SciPy: heat transfer, laminar duct flow, solid mechanics and diffusion. Every material input is traced to an approved library record from your papers."
        actions={<>
          <Select value={twin?.id ?? ''} onChange={(e) => { const p = new URLSearchParams(params); p.set('twin', e.target.value); setParams(p) }} className="w-56">
            {list.length === 0 && <option value="">No twins yet</option>}
            {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Button size="sm" onClick={() => create()}><Plus className="h-3.5 w-3.5" />New twin</Button>
          {list.length === 0 && <Button size="sm" variant="ghost" onClick={demo}>Demo twins</Button>}
          {twin && <Button size="sm" variant="ghost" onClick={remove} title="Delete twin"><Trash2 className="h-3.5 w-3.5" /></Button>}
          {twin && <Button size="sm" variant="primary" onClick={compute} disabled={job?.status === 'running' || job?.status === 'queued'}><Play className="h-3.5 w-3.5" />Compute (F5)</Button>}
        </>} />
      {!twin ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-neutral-500">
          <Boxes className="h-10 w-10 text-rose-500" />
          <p>No digital twin in this project yet.</p>
          <div className="flex gap-2">
            <Button onClick={() => create(['heat'])}>Heat-transfer twin</Button>
            <Button onClick={() => create(['flow'])}>Duct-flow twin</Button>
            <Button onClick={() => create(['structural'])}>Structural twin</Button>
          </div>
          <Button variant="ghost" onClick={demo} title="Imports the SYNTHETIC test paper, extracts and approves its values, and builds four example twins">Load demo twins (synthetic test data)</Button>
        </div>
      ) : (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[
            { id: 'geometry', label: 'Geometry' }, { id: 'material', label: <span>Materials {inputs && !inputs.ready && <span className="ml-1 rounded bg-amber-500 px-1 text-[10px] text-white">{inputs.missing.length} missing</span>}</span> },
            { id: 'physics', label: `Physics (${twin.physics.filter((p) => p.enabled).length})` }, { id: 'mesh', label: 'Mesh' }, { id: 'study', label: 'Study' }, { id: 'results', label: `Results${studies.length ? ` (${studies.length})` : ''}` },
          ]} />
          <div className="min-h-0 flex-1 pt-2">
            <TwinView tab={tab} twin={twin} preview={preview} previewErr={previewErr} study={study} job={job} />
          </div>
          <Inspector>
            <div className="space-y-3 text-xs">
              {tab === 'geometry' && <GeometryPanel twin={twin} cat={cat} preview={preview} update={update} />}
              {tab === 'material' && <MaterialPanel twin={twin} inputs={inputs} materials={materials} update={update} />}
              {tab === 'physics' && <PhysicsPanel twin={twin} cat={cat} preview={preview} update={update} addPhysics={addPhysics} />}
              {tab === 'mesh' && <MeshPanel twin={twin} cat={cat} preview={preview} update={update} />}
              {tab === 'study' && <StudyPanel twin={twin} inputs={inputs} job={job} compute={compute} cancel={cancel} />}
              {tab === 'results' && <StudiesPanel studies={studies} study={study} onOpen={(id) => api.get<Study>(`/api/studies/${id}`).then(setStudy)}
                onDelete={async (id) => { await api.del(`/api/studies/${id}`); setStudies(studies.filter((s) => s.id !== id)); if (study?.id === id) setStudy(null) }} />}
            </div>
          </Inspector>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ graphics */
function TwinView({ tab, twin, preview, previewErr, study, job }: { tab: Tab; twin: Twin; preview: Preview | null; previewErr: string | null; study: Study | null; job: Job | null }) {
  if (tab === 'results' || (tab === 'study' && study && job?.status !== 'running')) return study ? <ResultsView study={study} /> : <div className="p-6 text-sm text-neutral-500">No study yet. Open the Study tab and press Compute (F5).</div>
  if (previewErr) return <Alert kind="error" title="Geometry error">{previewErr}</Alert>
  if (!preview) return <div className="p-6 text-sm text-neutral-500">Building geometry…</div>
  return <GeometryScene tab={tab} twin={twin} preview={preview} job={job} />
}

function useFitOnce(key: string) {
  const [fit, setFit] = useState(0)
  const done = useRef<string | null>(null)
  const onReady = useCallback(() => {
    if (done.current === key) return
    done.current = key
    setTimeout(() => setFit((f) => f + 1), 30)
  }, [key])
  return { fit, onReady }
}

function GeometryScene({ tab, twin, preview, job }: { tab: Tab; twin: Twin; preview: Preview; job: Job | null }) {
  const m = preview.mesh
  const size = Math.max(m.nx, m.ny) * m.h_mm
  const { fit, onReady } = useFitOnce(`${twin.id}:${m.nx}x${m.ny}:${twin.geometry.depth}`)
  const segs = m.segments.filter((g) => g.faces > 0)
  const cellColors = useMemo(() => {
    if (tab !== 'physics') return null
    const c: (string | null)[] = new Array(m.cells).fill(null)
    segs.forEach((g, i) => (m.boundary_cells[g.id] ?? []).forEach((k) => { c[k] = SEGMENT_COLORS[i % SEGMENT_COLORS.length] }))
    return c
  }, [tab, m])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex h-full flex-col gap-2">
      <GraphicsView initialPreset="front" gridSize={Math.ceil((size * 2.5) / 10) * 10} fitSignal={fit}
        legend={tab === 'physics' && <div className="space-y-0.5 rounded bg-black/60 p-1.5 text-[10px] text-white">{segs.map((g, i) => <div key={g.id} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }} />{g.label}</div>)}</div>}>
        <group position={[0, (m.ny * m.h_mm) / 2, 0]}>
          <TwinField mesh={m} color={tab === 'mesh' ? '#e5e7eb' : '#c9a46c'} onReady={onReady} cellColors={cellColors} />
          {tab === 'mesh' && <TwinMeshLines mesh={m} />}
        </group>
      </GraphicsView>
      {job && ['running', 'queued'].includes(job.status) && <JobBar job={job} />}
      <ResultsSlot>
        <KV rows={[['Cross-section area', `${fmt(preview.geometry.area_mm2)} mm²`], ['Perimeter', `${fmt(preview.geometry.perimeter_mm)} mm`], ['Hydraulic diameter', `${fmt(preview.geometry.hydraulic_diameter_mm)} mm`],
          ['Depth / length', `${fmt(twin.geometry.depth)} mm`], ['Mesh', `${m.cells} cells, h = ${fmt(m.h_mm)} mm`], ['Staircase area error', `${fmt(m.area_error_pct, 3)} %`]]} />
      </ResultsSlot>
    </div>
  )
}

function JobBar({ job }: { job: Job }) {
  return (
    <div className="flex items-center gap-2 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-white/10">
      <span className="w-20 font-medium">{job.status}</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-200 dark:bg-white/10"><div className="h-full bg-rose-600 transition-all" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
      <span className="w-10 text-right">{Math.round(job.progress * 100)} %</span>
      <span className="max-w-[40%] truncate text-neutral-500">{job.log[job.log.length - 1]?.msg}</span>
    </div>
  )
}

type FieldDef = { id: string; label: string; unit: string; scale: number; map: string; get: (r: StudyRes, frame: number) => (number | null)[] | undefined; frames?: (r: StudyRes) => number[] }
const FIELDS: Record<string, FieldDef[]> = {
  heat: [
    { id: 'T', label: 'Temperature', unit: '°C', scale: 1, map: 'thermal', get: (r, f) => (r.frames as number[][])[f], frames: (r) => r.times as number[] },
    { id: 'X', label: 'Remaining fraction X (kinetics)', unit: '–', scale: 1, map: 'viridis', get: (r, f) => (r.kinetics_frames as number[][] | undefined)?.[f], frames: (r) => r.times as number[] },
  ],
  diffusion: [{ id: 'c', label: 'Concentration', unit: '', scale: 1, map: 'viridis', get: (r, f) => (r.frames as number[][])[f], frames: (r) => r.times as number[] }],
  flow: [
    { id: 'w', label: 'Axial velocity', unit: 'mm/s', scale: 1000, map: 'viridis', get: (r) => r.velocity as number[] },
    { id: 'gd', label: 'Shear rate', unit: '1/s', scale: 1, map: 'thermal', get: (r) => r.shear_rate as number[] },
    { id: 'mu', label: 'Apparent viscosity (log₁₀)', unit: 'log Pa·s', scale: 1, map: 'stress', get: (r) => (r.viscosity as number[]).map((v) => Math.log10(v)) },
    { id: 'tau', label: 'Shear stress', unit: 'Pa', scale: 1, map: 'stress', get: (r) => r.shear_stress as number[] },
  ],
  structural: [
    { id: 'vm', label: 'von Mises stress', unit: 'kPa', scale: 1e-3, map: 'stress', get: (r) => r.von_mises as number[] },
    { id: 'u', label: 'Displacement magnitude', unit: 'µm', scale: 1e6, map: 'viridis', get: (r) => r.displacement as number[] },
    { id: 'syy', label: 'Stress σyy', unit: 'kPa', scale: 1e-3, map: 'diverging', get: (r) => r.sigma_yy as number[] },
    { id: 'sxx', label: 'Stress σxx', unit: 'kPa', scale: 1e-3, map: 'diverging', get: (r) => r.sigma_xx as number[] },
  ],
}

function ResultsView({ study }: { study: Study }) {
  const ids = Object.keys(study.results)
  const [rid, setRid] = useState(ids[0])
  const r = study.results[rid] ?? study.results[ids[0]]
  const fields = (FIELDS[r.kind] ?? []).filter((f) => f.get(r, 0) !== undefined)
  const [fid, setFid] = useState(fields[0]?.id)
  const fd = fields.find((f) => f.id === fid) ?? fields[0]
  const times = fd?.frames?.(r) ?? [0]
  const [frame, setFrame] = useState(times.length - 1)
  const [scale, setScale] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(() => { setRid(ids[0]) }, [study.id])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFid(fields[0]?.id); setFrame((fd?.frames?.(r) ?? [0]).length - 1) }, [rid, study.id])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setFrame((f) => (f + 1) % times.length), 350)
    return () => clearInterval(t)
  }, [playing, times.length])
  const raw = fd ? fd.get(r, Math.min(frame, times.length - 1)) : undefined
  const vals = useMemo(() => raw?.map((v) => (v == null ? null : v * fd.scale)) ?? null, [raw, fd])
  // range over all frames for animations (fixed colour scale)
  const range = useMemo<[number, number]>(() => {
    if (!fd) return [0, 1]
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k < times.length; k++) for (const v of fd.get(r, k) ?? []) if (v != null) { lo = Math.min(lo, v * fd.scale); hi = Math.max(hi, v * fd.scale) }
    return lo === hi ? [lo - 1, hi + 1] : [lo, hi]
  }, [r, fd, times.length])
  const m = study.mesh
  const size = Math.max(m.nx, m.ny) * m.h_mm
  const disp = r.kind === 'structural' ? { ux: r.ux as number[], uy: r.uy as number[] } : null
  const autoScale = disp ? (0.08 * size) / Math.max(1e-12, (r.max_displacement_m as number) * 1000) : 0
  const dScale = scale ?? Math.max(1, Math.round(autoScale))
  const { fit, onReady } = useFitOnce(study.id)
  const unyielded = r.kind === 'flow' && fid === 'w' ? (r.unyielded as number[] | undefined) ?? null : null

  // centre-line profile of the current field
  const profile = useMemo(() => {
    if (!vals) return null
    const { xs, ys } = cellCentres(m)
    const yMid = ys.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), Infinity)
    const pts = xs.map((x, k) => ({ x, y: ys[k], v: vals[k] })).filter((p) => Math.abs(p.y - yMid) < 1e-9).sort((a, b) => a.x - b.x)
    return pts
  }, [vals, m])

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select value={rid} onChange={(e) => setRid(e.target.value)} className="w-56">{ids.map((k) => <option key={k} value={k}>{study.results[k].label}</option>)}</Select>
        <Select value={fd?.id} onChange={(e) => setFid(e.target.value)} className="w-56">{fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>
        {times.length > 1 && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setPlaying(!playing)}>{playing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
            <input type="range" min={0} max={times.length - 1} value={Math.min(frame, times.length - 1)} onChange={(e) => { setPlaying(false); setFrame(Number(e.target.value)) }} className="w-48" aria-label="Time" />
            <span className="num">t = {fmt(times[Math.min(frame, times.length - 1)])} s</span>
          </>
        )}
        {disp && <label className="flex items-center gap-1">Deformation ×<NumInput value={dScale} onChange={(v) => setScale(v)} className="w-20" /></label>}
        <span className="ml-auto text-neutral-500">{study.name} · {m.cells} cells · {study.elapsed_s} s</span>
      </div>
      {study.warnings.length > 0 && <Alert kind="warn">{study.warnings.slice(0, 4).join(' · ')}{study.warnings.length > 4 ? ` (+${study.warnings.length - 4} more in Warnings)` : ''}</Alert>}
      <div className="min-h-0 flex-1">
        <GraphicsView initialPreset="front" gridSize={Math.ceil((size * 2.5) / 10) * 10} fitSignal={fit} legend={fd && <Legend title={fd.label} unit={fd.unit} range={range} map={fd.map} />}>
          <group position={[0, (m.ny * m.h_mm) / 2, 0]}>
            <TwinField mesh={m} values={vals} range={range} map={fd?.map} disp={disp} dispScale={dScale} mask={unyielded} onReady={onReady} />
          </group>
        </GraphicsView>
      </div>
      <ResultsSlot><ResultSummary r={r} study={study} /></ResultsSlot>
      <PlotsSlot>
        <div className="grid gap-2 @3xl:grid-cols-2">
          {(r.kind === 'heat' || r.kind === 'diffusion') && <HistoryPlot r={r} />}
          {profile && fd && <Plot height={240} data={[{ x: profile.map((p) => p.x), y: profile.map((p) => p.v), type: 'scatter', mode: 'lines+markers', marker: { size: 3 }, name: fd.label }]}
            layout={{ title: { text: `${fd.label} along the horizontal centre line`, font: { size: 11 } }, xaxis: { title: { text: 'x [mm]' } }, yaxis: { title: { text: `${fd.label} [${fd.unit}]` } } }} />}
        </div>
      </PlotsSlot>
    </div>
  )
}

function HistoryPlot({ r }: { r: StudyRes }) {
  const h = r.history as Record<string, number[]>
  const unit = r.kind === 'heat' ? '°C' : ''
  const data = [
    { x: h.t, y: h.max, name: 'max', type: 'scatter' as const, mode: 'lines' as const },
    { x: h.t, y: h.mean, name: 'mean', type: 'scatter' as const, mode: 'lines' as const },
    { x: h.t, y: h.min, name: 'min (slowest point)', type: 'scatter' as const, mode: 'lines' as const },
    { x: h.t, y: h.probe, name: 'centre probe', type: 'scatter' as const, mode: 'lines' as const, line: { dash: 'dot' as const } },
    ...(h.x_mean ? [{ x: h.t, y: h.x_mean, name: 'X mean', yaxis: 'y2', type: 'scatter' as const, mode: 'lines' as const }, { x: h.t, y: h.x_min, name: 'X min', yaxis: 'y2', type: 'scatter' as const, mode: 'lines' as const }] : []),
  ]
  return <Plot height={240} data={data} layout={{ title: { text: r.kind === 'heat' ? 'Temperature history' : 'Concentration history', font: { size: 11 } }, xaxis: { title: { text: 't [s]' } }, yaxis: { title: { text: unit || 'c' } },
    ...(h.x_mean ? { yaxis2: { title: { text: 'X [–]' }, overlaying: 'y', side: 'right', range: [0, 1.05] } } : {}) }} />
}

function ResultSummary({ r, study }: { r: StudyRes; study: Study }) {
  const n = (k: string) => r[k] as number
  let rows: [string, string][] = []
  if (r.kind === 'heat' || r.kind === 'diffusion') {
    const h = r.history as Record<string, number[]>
    const u = r.kind === 'heat' ? ' °C' : ''
    const tgt = r.target as { value: number; time_all_cells_reached_s: number | null } | undefined
    const bal = r.balance as { total_inflow: number; stored_change?: number }
    rows = [['Final min / mean / max', `${fmt(h.min.at(-1))} / ${fmt(h.mean.at(-1))} / ${fmt(h.max.at(-1))}${u}`], ['Centre probe (final)', `${fmt(h.probe.at(-1))}${u}`],
      ...(tgt ? [[`Time until all cells ≥ ${tgt.value}${u}`, tgt.time_all_cells_reached_s == null ? 'not reached' : `${fmt(tgt.time_all_cells_reached_s)} s`] as [string, string]] : []),
      ...(h.x_mean ? [['Remaining fraction X mean / min', `${fmt(h.x_mean.at(-1))} / ${fmt(h.x_min.at(-1))}`] as [string, string]] : []),
      ...(r.thermal_diffusivity_m2_s ? [['Thermal diffusivity α', `${fmt(n('thermal_diffusivity_m2_s'))} m²/s`] as [string, string]] : []),
      ...(r.biot_number !== undefined ? [['Biot number (h·Lc/k)', fmt(n('biot_number'))] as [string, string]] : []),
      ...(r.fourier_number !== undefined ? [['Fourier number (α·t/Lc²)', fmt(n('fourier_number'))] as [string, string]] : []),
      ...(bal?.stored_change !== undefined ? [[r.kind === 'heat' ? 'Energy stored' : 'Amount taken up', `${fmt(bal.stored_change)}${r.kind === 'heat' ? ' J' : ''}`] as [string, string]] : []),
      ['Time step / steps', r.dt ? `${fmt(n('dt'))} s × ${n('steps')}` : 'steady state']]
  } else if (r.kind === 'flow') {
    const fb = r.force_balance as { relative_error: number }
    rows = [['Flow rate', `${fmt(n('flow_rate_m3_s') * 3.6e6)} L/h`], ...(r.mass_flow_kg_h ? [['Mass flow', `${fmt(n('mass_flow_kg_h'))} kg/h`] as [string, string]] : []),
      ['Pressure gradient', `${fmt(n('pressure_gradient_pa_m') / 1000)} kPa/m`], ['Pressure drop over length', `${fmt(n('pressure_drop_pa') / 1000)} kPa (L = ${fmt(n('length_m') * 1000)} mm)`],
      ['Mean / max velocity', `${fmt(n('mean_velocity_m_s') * 1000)} / ${fmt(n('max_velocity_m_s') * 1000)} mm/s`], ['Wall shear stress (avg, force balance)', `${fmt(n('wall_shear_stress_avg_pa'))} Pa`],
      ['Max shear rate', `${fmt(n('max_shear_rate_s'))} 1/s`], ['Hydraulic power', `${fmt(n('hydraulic_power_w'))} W`],
      ...(r.reynolds_generalised !== undefined ? [['Generalised Reynolds number', `${fmt(n('reynolds_generalised'))} (${r.laminar ? 'laminar' : 'NOT laminar'})`] as [string, string]] : []),
      ...(r.unyielded_fraction !== undefined ? [['Unyielded (plug) fraction', `${fmt(n('unyielded_fraction') * 100, 3)} %`] as [string, string]] : []),
      ['Picard iterations / force-balance error', `${n('picard_iterations')} / ${fmt(fb.relative_error * 100, 2)} %`]]
  } else if (r.kind === 'structural') {
    const eq = r.equilibrium as { residual_n: number; reaction_fy_n: number }
    rows = [['Max displacement', `${fmt(n('max_displacement_m') * 1e6)} µm`], ['Max von Mises stress', `${fmt(n('max_von_mises_pa') / 1000)} kPa`],
      ['σyy range', `${fmt(n('min_sigma_yy_pa') / 1000)} … ${fmt(n('max_sigma_yy_pa') / 1000)} kPa`],
      ...(r.safety_factor !== undefined ? [['Safety factor vs fracture stress', fmt(n('safety_factor'), 3)] as [string, string]] : [['Safety factor', 'no approved fracture-stress record'] as [string, string]]),
      ['Strain energy', `${fmt(n('strain_energy_j'))} J`], ['Vertical reaction', `${fmt(eq.reaction_fy_n)} N`], ['Equilibrium residual', `${fmt(eq.residual_n)} N`], ['DOFs / elements', `${n('dofs')} / ${n('elements')}`], ['Model', `plane ${r.plane}`]]
  }
  return (
    <div className="grid gap-3 text-xs @3xl:grid-cols-2">
      <div>
        <div className="mb-1 font-semibold">{r.label}</div>
        <div className="mb-2"><Equation latex={r.equation as string} /></div>
        <KV rows={rows} />
      </div>
      <InputsTable inputs={study.inputs} />
    </div>
  )
}

function SourceLink({ s }: { s?: SourceRef | null }) {
  if (!s?.paper_id) return <span className="text-neutral-500">{s?.citation ?? '—'}</span>
  return <Link className="inline-flex items-center gap-0.5 text-rose-600 underline" to={`/papers?paper=${s.paper_id}`}>{s.title ?? 'paper'}{s.page ? `, p. ${s.page}` : ''}<ExternalLink className="h-3 w-3" />{s.synthetic && <span className="ml-1 rounded bg-red-600 px-1 text-[9px] text-white no-underline">SYNTHETIC</span>}</Link>
}

function InputsTable({ inputs }: { inputs: Inputs }) {
  return (
    <div>
      <div className="mb-1 font-semibold">Material inputs used</div>
      <table className="w-full text-[11px]">
        <tbody>
          {Object.values(inputs.quantities).map((q) => (
            <tr key={q.quantity} className="border-t border-neutral-200 align-top dark:border-white/10">
              <td className="py-0.5 pr-2">{q.label}</td>
              <td className="num py-0.5 pr-2">{valueText(q)}</td>
              <td className="py-0.5"><Badge tone={q.origin === 'manual' ? 'amber' : q.origin ? 'green' : 'red'}>{q.origin ?? 'missing'}</Badge> <SourceLink s={q.source} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ inspector panels */
const H = ({ children }: { children: React.ReactNode }) => <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{children}</div>

function GeometryPanel({ twin, cat, preview, update }: { twin: Twin; cat: Catalogue; preview: Preview | null; update: (p: Partial<Twin>) => void }) {
  const g = twin.geometry
  const shape = cat.shapes[g.shape]
  const params = { ...shape?.params, ...g.params }
  const setParam = (k: string, v: unknown) => update({ geometry: { ...g, params: { ...params, [k]: v } } })
  const [pts, setPts] = useState('')
  useEffect(() => { if (g.shape === 'polygon') setPts(((params.points as number[][]) ?? []).map((p) => p.join(', ')).join('\n')) }, [g.shape, twin.id])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <H>Twin</H>
      <Field label="Name"><Input value={twin.name} onChange={(e) => update({ name: e.target.value })} /></Field>
      <H>Cross-section</H>
      <Field label="Shape">
        <Select value={g.shape} onChange={(e) => update({ geometry: { ...g, shape: e.target.value, params: { ...cat.shapes[e.target.value].params } } })}>
          {Object.entries(cat.shapes).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </Select>
      </Field>
      {Object.entries(params).filter(([k]) => k !== 'points' || g.shape === 'star').map(([k, v]) => (
        <Field key={k} label={`${PARAM_LABEL[k] ?? k}${k === 'points' ? '' : ' [mm]'}`}><NumInput value={v as number} onChange={(x) => x != null && setParam(k, x)} allowNull={false} /></Field>
      ))}
      {g.shape === 'polygon' && (
        <Field label="Vertices x, y [mm] (one per line)" hint="Counter- or clockwise outline; edit freely to define any cross-section.">
          <textarea className="h-32 w-full rounded border border-neutral-300 bg-white p-1 font-mono text-[11px] dark:border-neutral-700 dark:bg-neutral-950" value={pts}
            onChange={(e) => setPts(e.target.value)}
            onBlur={() => {
              const p = pts.split('\n').map((l) => l.split(/[,;\s]+/).filter(Boolean).map(Number)).filter((a) => a.length >= 2 && a.every(Number.isFinite)).map((a) => [a[0], a[1]])
              if (p.length >= 3) setParam('points', p)
            }} />
        </Field>
      )}
      <Field label="Depth / extrusion length [mm]" hint="Used for the 3-D view, plane-stress thickness, duct length and totals."><NumInput value={g.depth} onChange={(x) => x && x > 0 && update({ geometry: { ...g, depth: x } })} allowNull={false} /></Field>
      {preview && <KV rows={[['Area', `${fmt(preview.geometry.area_mm2)} mm²`], ['Perimeter', `${fmt(preview.geometry.perimeter_mm)} mm`], ['Hydraulic diameter', `${fmt(preview.geometry.hydraulic_diameter_mm)} mm`]]} />}
      <p className="text-[11px] text-neutral-500">The model is 2-D: fields vary over the cross-section and are uniform along the depth.</p>
    </>
  )
}

function MaterialPanel({ twin, inputs, materials, update }: { twin: Twin; inputs: Inputs | null; materials: { id: string; name: string }[]; update: (p: Partial<Twin>) => void }) {
  const m = twin.material
  const setSource = (q: string, s: Dict) => update({ material: { ...m, sources: { ...m.sources, [q]: s } } })
  return (
    <>
      <H>Domain material</H>
      <Field label="Library material"><Select value={m.material_id ?? ''} onChange={(e) => update({ material: { material_id: e.target.value, sources: {} } })}>{materials.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
      <Field label="Operating temperature [°C]" hint="Used to pick the record/model measured closest to these conditions."><NumInput value={twin.conditions.temperature_c} onChange={(v) => v != null && update({ conditions: { ...twin.conditions, temperature_c: v } })} allowNull={false} /></Field>
      {m.material_id && <Link to={`/libraries`} className="inline-flex items-center gap-1 text-rose-600 underline">Open library <ExternalLink className="h-3 w-3" /></Link>}
      <H>Required properties</H>
      {!inputs && <p className="text-neutral-500">Resolving…</p>}
      {inputs && Object.values(inputs.quantities).map((q) => {
        const ch = (m.sources[q.quantity] ?? { mode: 'auto' }) as Dict
        const key = ch.mode === 'record' ? `record:${ch.record_id}` : ch.mode === 'model' ? `model:${ch.model_id}` : String(ch.mode ?? 'auto')
        return (
          <div key={q.quantity} className={cx('space-y-1 rounded border p-2', q.value == null && q.required ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/20' : 'border-neutral-200 dark:border-white/10')}>
            <div className="flex items-center justify-between"><b>{q.label}</b>{!q.required && <Badge>optional</Badge>}</div>
            <Select value={key} onChange={(e) => {
              const v = e.target.value
              if (v.startsWith('record:')) setSource(q.quantity, { mode: 'record', record_id: v.slice(7) })
              else if (v.startsWith('model:')) setSource(q.quantity, { mode: 'model', model_id: v.slice(6) })
              else setSource(q.quantity, { mode: v })
            }}>
              <option value="auto">Automatic (best approved record / model)</option>
              {q.models?.map((c) => <option key={c.id} value={`model:${c.id}`}>Model: {c.name} [{c.status}]</option>)}
              {q.candidates?.map((c) => <option key={c.id} value={`record:${c.id}`}>{fmt(c.value)} {unitLabel(c.unit)} · {c.status}{c.conditions && Object.keys(c.conditions).length ? ` · ${Object.entries(c.conditions).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}{c.source?.page ? ` · p.${c.source.page}` : ''}</option>)}
              {THERMAL.includes(q.quantity) && <option value="choi_okos">Calculated (Choi–Okos from composition)</option>}
              <option value="manual">Manual value (not from a paper)</option>
            </Select>
            {ch.mode === 'manual' && (q.quantity === 'rheology'
              ? <div className="grid grid-cols-3 gap-1">{(['tau0', 'K', 'n'] as const).map((k) => <Field key={k} label={k === 'tau0' ? 'τ₀ [Pa]' : k === 'K' ? 'K [Pa·sⁿ]' : 'n'}><NumInput value={ch[k] as number} onChange={(v) => setSource(q.quantity, { ...ch, [k]: v })} /></Field>)}</div>
              : q.quantity === 'kinetics'
                ? <div className="grid grid-cols-3 gap-1">{([['k_ref', 'k_ref [1/s]'], ['Ea', 'Eₐ [J/mol]'], ['T_ref_c', 'T_ref [°C]']] as const).map(([k, l]) => <Field key={k} label={l}><NumInput value={ch[k] as number} onChange={(v) => setSource(q.quantity, { ...ch, [k]: v })} /></Field>)}</div>
                : <NumInput value={ch.value as number} onChange={(v) => setSource(q.quantity, { ...ch, value: v })} placeholder="SI value" />)}
            {q.value != null ? (
              <div className="space-y-0.5">
                <div className="num font-medium">{valueText(q)}</div>
                <div className="flex flex-wrap items-center gap-1"><Badge tone={q.origin === 'manual' ? 'amber' : 'green'}>{q.origin}</Badge>{q.method && <span className="text-neutral-500">{q.method}</span>}<SourceLink s={q.source} /></div>
                {q.flags.map((f) => <div key={f} className="text-amber-700 dark:text-amber-400">⚠ {f}</div>)}
              </div>
            ) : <div className="text-amber-800 dark:text-amber-300">{q.message}</div>}
          </div>
        )
      })}
      {inputs && !inputs.ready && <Alert kind="warn" title="Not ready">Approve the missing quantities in a library (Research Papers → Extraction & review), or choose another source.</Alert>}
    </>
  )
}

function PhysicsPanel({ twin, cat, preview, update, addPhysics }: { twin: Twin; cat: Catalogue; preview: Preview | null; update: (p: Partial<Twin>) => void; addPhysics: (k: string) => void }) {
  const segs = (preview?.mesh.segments ?? []).filter((g) => g.faces > 0)
  const setPh = (id: string, p: Partial<Physics>) => update({ physics: twin.physics.map((x) => (x.id === id ? { ...x, ...p } : x)) })
  return (
    <>
      <H>Add physics</H>
      <div className="flex flex-wrap gap-1">
        {['heat', 'flow', 'structural', 'diffusion', 'kinetics'].map((k) => <Button key={k} size="sm" onClick={() => addPhysics(k)}><Plus className="h-3 w-3" />{k === 'kinetics' ? 'Kinetics (with heat)' : cat.physics[k]?.label.split(' (')[0]}</Button>)}
      </div>
      {twin.physics.map((p) => {
        const st = p.settings
        const set = (k: string, v: unknown) => setPh(p.id, { settings: { ...st, [k]: v } })
        return (
          <div key={p.id} className="space-y-2 rounded border border-neutral-200 p-2 dark:border-white/10">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={p.enabled} onChange={(e) => setPh(p.id, { enabled: e.target.checked })} />
              <b className="flex-1">{p.label}</b>
              <button className="text-neutral-400 hover:text-red-600" onClick={() => update({ physics: twin.physics.filter((x) => x.id !== p.id) })} title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            <Equation latex={cat.physics[p.kind].equation} className="block overflow-x-auto text-[11px]" />
            {(p.kind === 'heat' || p.kind === 'diffusion') && (
              <div className="grid grid-cols-2 gap-1">
                <label className="col-span-2 flex items-center gap-1"><input type="checkbox" checked={!!st.steady} onChange={(e) => set('steady', e.target.checked)} />Stationary (steady state)</label>
                <Field label={p.kind === 'heat' ? 'Initial T [°C]' : `Initial c [${st.unit ?? ''}]`}><NumInput value={(p.kind === 'heat' ? st.initial_c : st.initial) as number} onChange={(v) => set(p.kind === 'heat' ? 'initial_c' : 'initial', v ?? 0)} /></Field>
                <Field label="End time [s]"><NumInput value={st.t_end_s as number} onChange={(v) => set('t_end_s', v)} disabled={!!st.steady} /></Field>
                <Field label="Time step [s]" hint="empty = automatic"><NumInput value={st.dt_s as number | null} onChange={(v) => set('dt_s', v)} disabled={!!st.steady} /></Field>
                {p.kind === 'heat' && <Field label="Heat source [W/m³]"><NumInput value={st.source_w_m3 as number} onChange={(v) => set('source_w_m3', v ?? 0)} /></Field>}
                {p.kind === 'heat' && <Field label="Target T [°C]" hint="report when every cell reaches it"><NumInput value={st.target_c as number | null} onChange={(v) => set('target_c', v)} /></Field>}
                {p.kind === 'heat' && <label className="col-span-2 flex items-center gap-1"><input type="checkbox" checked={!!(st.kinetics as Dict | undefined)?.enabled} onChange={(e) => set('kinetics', { enabled: e.target.checked })} />Couple first-order reaction kinetics (e.g. protein denaturation)</label>}
                {p.kind === 'diffusion' && <Field label="Concentration unit"><Input value={st.unit as string} onChange={(e) => set('unit', e.target.value)} /></Field>}
              </div>
            )}
            {p.kind === 'flow' && (
              <div className="grid grid-cols-2 gap-1">
                <Field label="Drive" className="col-span-2"><Select value={st.mode as string} onChange={(e) => set('mode', e.target.value)}><option value="flow_rate">Prescribed flow rate</option><option value="pressure_gradient">Prescribed pressure gradient</option></Select></Field>
                {st.mode === 'flow_rate' ? <Field label="Flow rate [L/h]"><NumInput value={st.flow_rate_l_h as number} onChange={(v) => set('flow_rate_l_h', v)} /></Field>
                  : <Field label="−dp/dz [Pa/m]"><NumInput value={st.pressure_gradient_pa_m as number} onChange={(v) => set('pressure_gradient_pa_m', v)} /></Field>}
                <p className="col-span-2 text-[11px] text-neutral-500">Duct length = geometry depth ({fmt(twin.geometry.depth)} mm). All walls no-slip.</p>
              </div>
            )}
            {p.kind === 'structural' && (
              <div className="grid grid-cols-2 gap-1">
                <Field label="2-D model"><Select value={st.plane as string} onChange={(e) => set('plane', e.target.value)}><option value="stress">Plane stress (thin)</option><option value="strain">Plane strain (long)</option></Select></Field>
                <label className="flex items-center gap-1 pt-4"><input type="checkbox" checked={!!st.gravity} onChange={(e) => set('gravity', e.target.checked)} />Self-weight (gravity −y)</label>
              </div>
            )}
            {p.kind !== 'flow' && (
              <div className="space-y-1">
                <div className="font-medium">Boundary conditions</div>
                {[{ id: 'default', label: 'Default (all segments not set below)', faces: 0 }, ...segs].map((g, gi) => {
                  const isDef = g.id === 'default'
                  const own = p.bcs[g.id]
                  const bc = own ?? (isDef ? { type: BC_TYPES[p.kind][0].id } : null)
                  const def = bc ? BC_TYPES[p.kind].find((b) => b.id === bc.type) ?? BC_TYPES[p.kind][0] : null
                  const setBc = (b: BC | null) => {
                    const next = { ...p.bcs }
                    if (b) next[g.id] = b
                    else delete next[g.id]
                    setPh(p.id, { bcs: next })
                  }
                  return (
                    <div key={g.id} className="grid grid-cols-[110px_1fr] items-center gap-1">
                      <span className="flex items-center gap-1 truncate" title={g.label}>
                        {!isDef && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SEGMENT_COLORS[(gi - 1) % SEGMENT_COLORS.length] }} />}
                        <span className={cx('truncate', isDef && 'font-medium')}>{isDef ? 'Default' : g.label}</span>
                      </span>
                      <Select value={bc?.type ?? '__default'} onChange={(e) => setBc(e.target.value === '__default' ? null : { ...(bc ?? {}), type: e.target.value })}>
                        {!isDef && <option value="__default">— as default —</option>}
                        {BC_TYPES[p.kind].map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                      </Select>
                      {bc && def?.fields.map(([k, l]) => <div key={k} className="col-start-2 flex items-center gap-1"><span className="w-28 shrink-0 text-[10px] text-neutral-500">{l}</span><NumInput value={bc[k] as number} onChange={(v) => setBc({ ...bc, [k]: v ?? 0 })} /></div>)}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function MeshPanel({ twin, cat, preview, update }: { twin: Twin; cat: Catalogue; preview: Preview | null; update: (p: Partial<Twin>) => void }) {
  const m = preview?.mesh
  return (
    <>
      <H>Mesh</H>
      <Field label="Element size"><Select value={twin.mesh.cells_across ? 'custom' : twin.mesh.level} onChange={(e) => update({ mesh: e.target.value === 'custom' ? { level: 'normal', cells_across: 90 } : { level: e.target.value } })}>
        {Object.entries(cat.mesh_levels).map(([k, n]) => <option key={k} value={k}>{k.replace('_', ' ')} ({n} cells across)</option>)}
        <option value="custom">custom</option>
      </Select></Field>
      {twin.mesh.cells_across != null && <Field label="Cells across the largest dimension (8–220)"><NumInput value={twin.mesh.cells_across} onChange={(v) => v && update({ mesh: { ...twin.mesh, cells_across: Math.round(v) } })} /></Field>}
      {m && <KV rows={[['Grid', `${m.nx} × ${m.ny}`], ['Cell size h', `${fmt(m.h_mm)} mm`], ['Domain cells', String(m.cells)], ['FE nodes (structural)', String(m.nodes)],
        ['Exact / meshed area', `${fmt(m.exact_area_mm2)} / ${fmt(m.meshed_area_mm2)} mm²`], ['Staircase area error', `${fmt(m.area_error_pct, 3)} %`],
        ...m.segments.filter((g) => g.faces > 0).map((g) => [`Boundary: ${g.label}`, `${g.faces} faces`] as [string, string])]} />}
      <p className="text-[11px] text-neutral-500">Uniform square cells; curved walls are approximated by steps. Refine until the results stop changing (mesh-convergence check).</p>
    </>
  )
}

function StudyPanel({ twin, inputs, job, compute, cancel }: { twin: Twin; inputs: Inputs | null; job: Job | null; compute: () => void; cancel: () => void }) {
  const running = job && ['queued', 'running'].includes(job.status)
  return (
    <>
      <H>Study</H>
      <KV rows={[['Physics', twin.physics.filter((p) => p.enabled).map((p) => p.label).join(', ') || 'none'], ['Inputs', inputs?.ready ? 'complete' : `missing: ${inputs?.missing.join(', ') ?? '…'}`]]} />
      <div className="flex gap-2"><Button variant="primary" onClick={compute} disabled={!!running}><Play className="h-3.5 w-3.5" />Compute (F5)</Button>{running && <Button onClick={cancel}>Cancel</Button>}</div>
      {job && <JobBar job={job} />}
      {job?.status === 'failed' && <Alert kind="error" title="Study failed">{job.error}</Alert>}
      <p className="text-[11px] text-neutral-500">Studies run in the background; progress and messages stream to the Solver Log. The result is stored with a snapshot of the twin and the exact inputs and sources used.</p>
    </>
  )
}

function StudiesPanel({ studies, study, onOpen, onDelete }: { studies: StudyRow[]; study: Study | null; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  return (
    <>
      <H>Studies</H>
      {studies.length === 0 && <p className="text-neutral-500">No studies yet.</p>}
      {studies.map((s) => (
        <div key={s.id} className={cx('flex items-center gap-1 rounded px-1.5 py-1', s.id === study?.id ? 'bg-neutral-900 text-white dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>
          <button className="flex-1 text-left" onClick={() => onOpen(s.id)}>
            <div className="font-medium">{new Date(s.created).toLocaleString()}</div>
            <div className="text-[10px] opacity-75">{s.physics.join(' + ')} · {s.cells} cells · {s.elapsed_s} s</div>
          </button>
          <button onClick={() => onDelete(s.id)} title="Delete study" className="opacity-60 hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      {study && <Button size="sm" onClick={() => download(`${study.name.replace(/[^\w-]+/g, '_')}.json`, JSON.stringify(study, null, 1))}>Export results (JSON)</Button>}
    </>
  )
}
