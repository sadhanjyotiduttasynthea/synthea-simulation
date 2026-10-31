import { Copy, Download, Eye, EyeOff, Plus, Printer, Save, Trash2, Upload } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import { GraphicsView } from '../components/GraphicsView'
import { Alert, Button, Field, Input, KV, NumInput, PageHeader, Panel, Select, cx } from '../components/ui'
import { api, download, pickFile } from '../lib/api'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector } from '../workspace/Slots'

interface Obj { id?: string; kind: string; name?: string; params?: Record<string, number | number[][]>; position?: [number, number, number]; hidden?: boolean; vertices?: number[][]; faces?: number[][]; source?: Record<string, unknown> }
interface Kind { label: string; params: Record<string, number | number[][]> }
interface Info { triangles: number; volume_mm3: number; surface_mm2: number; bbox_mm: [number[], number[]]; overlap_warning?: string | null }
interface MeshData { id: string; vertices: number[][]; faces: number[][] }

const ALIAS: Record<string, string> = { cuboid: 'box', extrusion: 'polygon' }
const COLORS = ['#c9a46c', '#0891b2', '#16a34a', '#e11d48', '#7c3aed', '#f59e0b']
const PARAM_LABEL: Record<string, string> = { width: 'Width (x)', depth: 'Depth (y)', height: 'Height (z)', diameter: 'Diameter', inner_diameter: 'Inner diameter', top_diameter: 'Top diameter' }

/** Triangle mesh in print coordinates (z up) shown y-up. */
function MeshView({ data, color, selected, onClick }: { data: MeshData; color: string; selected: boolean; onClick: () => void }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices.flatMap(([x, y, z]) => [x, z, -y]), 3))
    g.setIndex(data.faces.flat())
    g.computeVertexNormals()
    return g
  }, [data])
  useLayoutEffect(() => () => geo.dispose(), [geo])
  return (
    <mesh geometry={geo} onClick={(e) => { e.stopPropagation(); onClick() }}>
      <meshStandardMaterial color={selected ? '#e11d48' : color} roughness={0.6} side={THREE.DoubleSide} />
    </mesh>
  )
}

export default function Geometry() {
  const { project, toast } = useStore()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [kinds, setKinds] = useState<Record<string, Kind>>({})
  const [objs, setObjs] = useState<Obj[]>([])
  const [meshes, setMeshes] = useState<MeshData[]>([])
  const [info, setInfo] = useState<Info | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [fit, setFit] = useState(0)
  const sel = params.get('sel')
  const setSel = (id: string | null) => setParams(id ? { sel: id } : {}, { replace: true })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { api.get<Record<string, Kind>>('/api/geometry/kinds').then(setKinds) }, [])
  useEffect(() => {
    if (!project) return
    api.get<{ objects: Obj[] }>(`/api/geometry?project_id=${project.id}`).then((d) => { setObjs(d.objects); setTimeout(() => setFit((f) => f + 1), 300) })
  }, [project])
  // rebuild meshes (what the slicer will see) when objects change
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const vis = objs.filter((o) => !o.hidden)
      if (!vis.length) { setMeshes([]); setInfo(null); return }
      try {
        const [m, i] = await Promise.all([api.post<MeshData[]>('/api/geometry/meshes', { objects: vis }), api.post<Info>('/api/geometry/info', { objects: vis })])
        setMeshes(m)
        setInfo(i)
        setErr(null)
      } catch (e) { setErr((e as Error).message) }
    }, 250)
  }, [objs])

  const update = (next: Obj[]) => { setObjs(next); setDirty(true) }
  const add = (kind: string) => {
    const k = ALIAS[kind] ?? kind
    if (!kinds[k]) return toast(`Unknown shape ${kind}`, 'error')
    const id = `obj-${Math.random().toString(36).slice(2, 10)}`
    update([...objs, { id, kind: k, name: `${kinds[k].label} ${objs.length + 1}`, params: structuredClone(kinds[k].params), position: [0, 0, 0] }])
    setSel(id)
  }
  const save = async () => {
    if (!project) return
    try {
      const d = await api.put<{ objects: Obj[] }>('/api/geometry', { project_id: project.id, objects: objs })
      setObjs(d.objects)
      setDirty(false)
      refreshTree()
      toast('Geometry saved', 'success')
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const importStl = async () => {
    try {
      const f = await pickFile('.stl')
      const o = await api.upload<Obj & { info: Info }>('/api/geometry/import-stl', f, f.name)
      update([...objs, o])
      setSel(o.id!)
      toast(`Imported ${f.name}: ${o.info.triangles} triangles, ${(o.info.volume_mm3 / 1000).toFixed(2)} cm³`, 'success')
      setTimeout(() => setFit((x) => x + 1), 400)
    } catch (e) { if ((e as Error).message !== 'No file selected') toast((e as Error).message, 'error') }
  }
  const exportStl = async () => download('synthea_geometry.stl', await api.blob('/api/geometry/stl', { objects: objs.filter((o) => !o.hidden), name: project?.name }), 'model/stl')
  useCommand('geometry.add', (k) => add(String(k)))
  useCommand('geometry.importStl', importStl)
  useCommand('geometry.exportStl', exportStl)

  const cur = objs.find((o) => o.id === sel)
  const setCur = (patch: Partial<Obj>) => update(objs.map((o) => (o.id === sel ? { ...o, ...patch } : o)))
  const [pts, setPts] = useState('')
  useEffect(() => { if (cur?.kind === 'polygon') setPts(((cur.params?.points as number[][]) ?? []).map((p) => p.join(', ')).join('\n')) }, [sel])  // eslint-disable-line react-hooks/exhaustive-deps
  const size = info ? Math.max(...info.bbox_mm[1].map((v, i) => v - info.bbox_mm[0][i])) : 60

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Geometry" subtitle="Prototype geometry for Synthea Print: sketches extruded in z, 3-D primitives or an imported STL. The 3D Printing Lab slices exactly these meshes."
        actions={<>
          <Select value="" onChange={(e) => e.target.value && add(e.target.value)} className="w-48"><option value="">Add shape…</option>{Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
          <Button size="sm" onClick={importStl}><Upload className="h-3.5 w-3.5" />Import STL</Button>
          <Button size="sm" onClick={exportStl} disabled={!objs.length}><Download className="h-3.5 w-3.5" />Export STL</Button>
          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} onClick={save}><Save className="h-3.5 w-3.5" />Save</Button>
          <Button size="sm" onClick={async () => { if (dirty) await save(); nav('/printing') }} disabled={!objs.length}><Printer className="h-3.5 w-3.5" />Print this</Button>
        </>} />
      <div className="grid min-h-0 flex-1 gap-3 @4xl:grid-cols-[230px_minmax(0,1fr)]">
        <Panel title={`Objects (${objs.length})`} bodyClass="p-1" className="min-h-0 overflow-y-auto">
          {objs.length === 0 && <p className="p-2 text-xs text-neutral-500">No objects. Add a shape or import an STL.</p>}
          {objs.map((o, i) => (
            <div key={o.id} className={cx('mb-0.5 flex items-center gap-1 rounded px-2 py-1 text-xs', o.id === sel ? 'bg-neutral-900 text-white dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
              <button className="flex-1 truncate text-left" onClick={() => setSel(o.id!)}>{o.name ?? o.kind}<span className="ml-1 opacity-60">{o.kind}</span></button>
              <button title={o.hidden ? 'Show' : 'Hide'} onClick={() => update(objs.map((x) => (x.id === o.id ? { ...x, hidden: !x.hidden } : x)))}>{o.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
            </div>
          ))}
          <div className="mt-2 grid grid-cols-2 gap-1 px-1">
            {['rectangle', 'circle', 'ring', 'polygon', 'box', 'cylinder', 'cone', 'sphere'].map((k) => <Button key={k} size="sm" onClick={() => add(k)}><Plus className="h-3 w-3" />{k}</Button>)}
          </div>
        </Panel>
        <div className="flex min-h-0 flex-col gap-2">
          {err && <Alert kind="error">{err}</Alert>}
          {info?.overlap_warning && <Alert kind="warn">{info.overlap_warning}</Alert>}
          <div className="min-h-0 flex-1">
            <GraphicsView gridSize={Math.max(100, Math.ceil(size * 3 / 10) * 10)} fitSignal={fit} onBackgroundClick={() => setSel(null)}>
              {meshes.map((m) => {
                const i = objs.findIndex((o) => o.id === m.id)
                return <MeshView key={m.id + JSON.stringify(objs[i]?.params) + JSON.stringify(objs[i]?.position)} data={m} color={COLORS[Math.max(0, i) % COLORS.length]} selected={m.id === sel} onClick={() => setSel(m.id)} />
              })}
            </GraphicsView>
          </div>
          {info && <KV rows={[['Volume', `${(info.volume_mm3 / 1000).toFixed(2)} cm³`], ['Bounding box', `${info.bbox_mm[0].map((v, k) => (info.bbox_mm[1][k] - v).toFixed(1)).join(' × ')} mm`], ['Triangles', String(info.triangles)]]} />}
        </div>
      </div>
      <Inspector>
        {cur ? (
          <div className="space-y-2 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{kinds[cur.kind]?.label ?? 'Imported mesh'}</div>
            <Field label="Name"><Input value={cur.name ?? ''} onChange={(e) => setCur({ name: e.target.value })} /></Field>
            {cur.kind !== 'mesh' && Object.entries(cur.params ?? {}).filter(([k]) => k !== 'points').map(([k, v]) => (
              <Field key={k} label={`${PARAM_LABEL[k] ?? k} [mm]`}><NumInput value={v as number} allowNull={false} onChange={(x) => x != null && setCur({ params: { ...cur.params, [k]: x } })} /></Field>
            ))}
            {cur.kind === 'polygon' && (
              <Field label="Sketch vertices x, y [mm] (one per line)">
                <textarea className="h-28 w-full rounded border border-neutral-300 bg-white p-1 font-mono text-[11px] dark:border-neutral-700 dark:bg-neutral-950" value={pts} onChange={(e) => setPts(e.target.value)}
                  onBlur={() => { const p = pts.split('\n').map((l) => l.split(/[,;\s]+/).filter(Boolean).map(Number)).filter((a) => a.length >= 2 && a.every(Number.isFinite)).map((a) => [a[0], a[1]]); if (p.length >= 3) setCur({ params: { ...cur.params, points: p } }) }} />
              </Field>
            )}
            {cur.kind === 'mesh' && <p className="text-neutral-500">Imported from {String(cur.source?.filename ?? 'STL')} ({cur.faces?.length} triangles). Placed on the bed and centred in x/y.</p>}
            <div className="grid grid-cols-3 gap-1">
              {(['x', 'y', 'z'] as const).map((ax, i) => (
                <Field key={ax} label={`${ax} [mm]`}><NumInput value={(cur.position ?? [0, 0, 0])[i]} allowNull={false} onChange={(x) => { const p = [...(cur.position ?? [0, 0, 0])] as [number, number, number]; p[i] = x ?? 0; setCur({ position: p }) }} /></Field>
              ))}
            </div>
            <div className="flex gap-1">
              <Button size="sm" onClick={() => { const id = `obj-${Math.random().toString(36).slice(2, 10)}`; update([...objs, { ...structuredClone(cur), id, name: `${cur.name} copy`, position: [(cur.position?.[0] ?? 0) + 10, cur.position?.[1] ?? 0, cur.position?.[2] ?? 0] }]); setSel(id) }}><Copy className="h-3 w-3" />Duplicate</Button>
              <Button size="sm" variant="danger" onClick={() => { update(objs.filter((o) => o.id !== cur.id)); setSel(null) }}><Trash2 className="h-3 w-3" />Delete</Button>
            </div>
            <p className="text-[10.5px] text-neutral-500">Positions are the base centre of the object (z = 0 is the print bed). Objects are not merged: keep them apart or stacked without overlap.</p>
          </div>
        ) : <p className="p-1 text-xs text-neutral-500">Select an object to edit its dimensions and position.</p>}
      </Inspector>
    </div>
  )
}
