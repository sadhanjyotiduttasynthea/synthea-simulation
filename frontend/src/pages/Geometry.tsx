import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { Box, Circle, Copy, Cylinder, Download, Eye, EyeOff, Hexagon, Layers, Minus, Palette, Plus, Square, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import { GraphicsView } from '../components/GraphicsView'
import { Alert, Button, Field, Input, NumInput, PageHeader, Panel, Prov, Select, cx } from '../components/ui'
import { api, download, pickFile } from '../lib/api'
import { fmtSci } from '../lib/format'
import { DIM_FIELDS, type GeoKind, type GeoObject, type GeometryDoc, IS_3D, buildGeometry, colorForKey, exportStl, fileToBase64, measures, newObject } from '../lib/geometry'
import type { Material } from '../lib/sci'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector } from '../workspace/Slots'
import { log, useWs } from '../workspace/wsStore'

const ADD: { kind: GeoKind; icon: typeof Box; label: string }[] = [
  { kind: 'cuboid', icon: Box, label: 'Cuboid' }, { kind: 'cylinder', icon: Cylinder, label: 'Cylinder' }, { kind: 'sphere', icon: Circle, label: 'Sphere' },
  { kind: 'extrusion', icon: Layers, label: 'Extrusion' }, { kind: 'rectangle', icon: Square, label: 'Rectangle' }, { kind: 'circle', icon: Circle, label: 'Circle' },
  { kind: 'polygon', icon: Hexagon, label: 'Polygon' }, { kind: 'line', icon: Minus, label: 'Line' }, { kind: 'point', icon: Plus, label: 'Point' },
]

function GeoMesh({ o, selected, color, onSelect }: { o: GeoObject; selected: boolean; color: string; onSelect: (e: ThreeEvent<PointerEvent>) => void }) {
  const geom = useMemo(() => buildGeometry(o), [o.kind, JSON.stringify(o.dims), JSON.stringify(o.points), o.stl_base64?.length])  // eslint-disable-line react-hooks/exhaustive-deps
  const rot = o.rotation.map((r) => (r * Math.PI) / 180) as [number, number, number]
  const flat = !IS_3D[o.kind]
  const edges = useMemo(() => (geom && !flat ? new THREE.EdgesGeometry(geom, 25) : null), [geom, flat])
  if (o.kind === 'point') {
    return <mesh position={o.position} onPointerDown={onSelect}><sphereGeometry args={[1.2, 16, 16]} /><meshStandardMaterial color={selected ? '#06b6d4' : color} /></mesh>
  }
  if (o.kind === 'line') {
    return <group position={o.position} rotation={rot}><Line points={(o.points ?? []).map(([x, y]) => [x, y, 0] as [number, number, number])} color={selected ? '#06b6d4' : color} lineWidth={3} onPointerDown={onSelect} /></group>
  }
  if (!geom) return null
  return (
    <group position={o.position} rotation={rot} scale={o.scale}>
      <mesh geometry={geom} onPointerDown={onSelect} position={flat ? [0, 0, 0.05] : [0, 0, 0]}>
        <meshStandardMaterial color={color} emissive={selected ? '#0e7490' : '#000000'} emissiveIntensity={selected ? 0.45 : 0} roughness={0.55} metalness={0.05} side={flat ? THREE.DoubleSide : THREE.FrontSide} transparent={flat} opacity={flat ? 0.75 : 1} userData={{ baseTransparent: flat, baseOpacity: flat ? 0.75 : 1, baseSide: flat ? THREE.DoubleSide : THREE.FrontSide }} />
      </mesh>
      {edges && <lineSegments geometry={edges} userData={{ noViewMode: true }}><lineBasicMaterial color={selected ? '#22d3ee' : '#1f2937'} transparent opacity={selected ? 1 : 0.35} /></lineSegments>}
    </group>
  )
}

export default function Geometry() {
  const { project, formulations, toast } = useStore()
  const select = useWs((s) => s.select)
  const [params, setParams] = useSearchParams()
  const [doc, setDoc] = useState<GeometryDoc | null>(null)
  const [sel, setSel] = useState<string | null>(params.get('sel'))
  const [dim, setDim] = useState<'3d' | '2d'>('3d')
  const [colorBy, setColorBy] = useState<'object' | 'material'>('object')
  const [mats, setMats] = useState<Material[]>([])
  const [fit, setFit] = useState(0)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!project) return
    api.get<GeometryDoc>(`/api/geometries?project_id=${project.id}`).then((g) => { setDoc(g); setFit((f) => f + 1) })
    api.get<Material[]>('/api/materials').then(setMats)
  }, [project])
  useEffect(() => { const s = params.get('sel'); if (s) setSel(s) }, [params])

  const persist = useCallback((next: GeometryDoc) => {
    setDoc(next)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      api.put<GeometryDoc>(`/api/geometries/${next.id}`, next).then(() => refreshTree()).catch((e) => toast((e as Error).message, 'error'))
    }, 400)
  }, [toast])

  const add = (kind: GeoKind) => {
    if (!doc) return
    const o = newObject(kind, doc.objects.length + 1)
    o.position = [o.position[0] + doc.objects.length * 5, o.position[1], o.position[2]]
    persist({ ...doc, objects: [...doc.objects, o] })
    setSel(o.id)
    log('info', 'geometry', `Added ${o.name}`)
  }
  useCommand('geometry.add', (k) => add((k as GeoKind) ?? 'cuboid'))
  const importStl = async () => {
    if (!doc) return
    try {
      const f = await pickFile('.stl')
      const b64 = await fileToBase64(f)
      const o: GeoObject = { ...newObject('stl', doc.objects.length + 1), name: f.name.replace(/\.stl$/i, ''), stl_base64: b64 }
      buildGeometry(o)
      persist({ ...doc, objects: [...doc.objects, o] })
      setSel(o.id)
      setFit((x) => x + 1)
      log('success', 'geometry', `Imported STL ${f.name} (${Math.round(b64.length * 0.75 / 1024)} kB)`)
    } catch (e) {
      if ((e as Error).message !== 'No file selected') toast(`STL import failed: ${(e as Error).message}`, 'error')
    }
  }
  const doExport = async () => {
    if (!doc) return
    const blob = await exportStl(doc.objects)
    await download(`${(project?.name ?? 'geometry').replace(/\W+/g, '_')}.stl`, blob, 'model/stl')
    log('success', 'geometry', 'Exported visible 3D objects as binary STL (mm)')
  }
  useCommand('geometry.importStl', importStl)
  useCommand('geometry.exportStl', doExport)

  const cur = doc?.objects.find((o) => o.id === sel) ?? null
  useEffect(() => { if (cur) select({ kind: 'geometry', id: cur.id, label: cur.name }) }, [cur?.id, cur?.name, select])  // eslint-disable-line react-hooks/exhaustive-deps
  const upd = (patch: Partial<GeoObject>) => doc && cur && persist({ ...doc, objects: doc.objects.map((o) => (o.id === cur.id ? { ...o, ...patch } : o)) })
  const remove = (id: string) => { if (!doc) return; persist({ ...doc, objects: doc.objects.filter((o) => o.id !== id) }); if (sel === id) setSel(null) }
  const duplicate = () => { if (!doc || !cur) return; const o = { ...structuredClone(cur), id: `obj-${Math.random().toString(36).slice(2, 9)}`, name: `${cur.name} copy`, position: [cur.position[0] + 10, cur.position[1] + 10, cur.position[2]] as [number, number, number] }; persist({ ...doc, objects: [...doc.objects, o] }); setSel(o.id) }

  const matLabel = (m: GeoObject['material']) => !m ? 'unassigned' : m.type === 'formulation' ? `Formulation: ${formulations.find((f) => f.id === m.id)?.name ?? m.id}` : mats.find((x) => x.id === m.id)?.name ?? m.id
  const colorOf = (o: GeoObject) => (colorBy === 'material' ? (o.material ? colorForKey(o.material.type + o.material.id) : '#d4d4d4') : o.color ?? '#9ca3af')
  const m = cur ? measures(cur) : null
  const legend = colorBy === 'material' && doc ? (
    <div className="rounded bg-white/90 px-2 py-1 text-[10.5px] shadow dark:bg-neutral-900/90">
      {[...new Map(doc.objects.filter((o) => o.visible).map((o) => [o.material ? o.material.type + o.material.id : 'none', o])).values()].map((o) => (
        <div key={o.id} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(o) }} />{matLabel(o.material)}</div>
      ))}
    </div>
  ) : undefined

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Geometry" subtitle="Engineering geometry in millimetres (x right, y depth, z up). Edit dimensions and transforms in Settings; changes update the graphics immediately and are saved with the project."
        actions={<>
          <Button size="sm" onClick={importStl}><Upload className="h-3.5 w-3.5" />Import STL</Button>
          <Button size="sm" onClick={doExport}><Download className="h-3.5 w-3.5" />Export STL</Button>
        </>} />
      <div className="grid min-h-0 flex-1 gap-3 @4xl:grid-cols-[210px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-2">
          <Panel title="Create" bodyClass="p-1.5 grid grid-cols-3 gap-1">
            {ADD.map((a) => (
              <button key={a.kind} onClick={() => add(a.kind)} className="flex flex-col items-center gap-0.5 rounded border border-neutral-200 py-1.5 text-[10.5px] hover:border-rose-500 dark:border-white/10">
                <a.icon className="h-4 w-4 text-rose-600" />{a.label}
              </button>
            ))}
          </Panel>
          <Panel title={`Geometry tree (${doc?.objects.length ?? 0})`} bodyClass="p-1" className="min-h-0 flex-1 overflow-y-auto">
            {doc?.objects.map((o) => (
              <div key={o.id} onClick={() => { setSel(o.id); setParams({ sel: o.id }) }} className={cx('group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs', o.id === sel ? 'bg-rose-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorOf(o) }} />
                <span className={cx('flex-1 truncate', !o.visible && 'opacity-40')}>{o.name}</span>
                <span className="text-[9.5px] opacity-60">{o.kind}</span>
                <button onClick={(e) => { e.stopPropagation(); persist({ ...doc, objects: doc.objects.map((x) => (x.id === o.id ? { ...x, visible: !x.visible } : x)) }) }} title="Toggle visibility">{o.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
              </div>
            ))}
            {doc && !doc.objects.length && <p className="p-2 text-xs text-neutral-500">Empty. Create objects or import an STL file.</p>}
          </Panel>
        </div>
        <div className="min-h-[420px]">
          <GraphicsView dimension={dim} fitSignal={fit} onBackgroundClick={() => setSel(null)} legend={legend} gridSize={300}
            toolbar={<>
              <button className={cx('h-6 rounded px-1.5 text-[11px]', dim === '2d' ? 'bg-rose-600 text-white' : 'text-neutral-300 hover:bg-white/10')} onClick={() => { setDim(dim === '3d' ? '2d' : '3d'); setFit((f) => f + 1) }}>{dim === '3d' ? '3D' : '2D (XY)'}</button>
              <button className={cx('flex h-6 items-center gap-1 rounded px-1.5 text-[11px]', colorBy === 'material' ? 'bg-rose-600 text-white' : 'text-neutral-300 hover:bg-white/10')} onClick={() => setColorBy(colorBy === 'object' ? 'material' : 'object')}><Palette className="h-3.5 w-3.5" />Material colours</button>
            </>}>
            <group rotation={[-Math.PI / 2, 0, 0]}>
              {doc?.objects.filter((o) => o.visible).map((o) => <GeoMesh key={o.id} o={o} selected={o.id === sel} color={colorOf(o)} onSelect={(e) => { e.stopPropagation(); setSel(o.id) }} />)}
            </group>
          </GraphicsView>
        </div>
      </div>

      <Inspector>
        {cur ? (
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{cur.kind}</span>
              <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={duplicate} title="Duplicate"><Copy className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" onClick={() => remove(cur.id)} title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button></span></div>
            <Field label="Name"><Input className="w-full" value={cur.name} onChange={(e) => upd({ name: e.target.value })} /></Field>
            {DIM_FIELDS[cur.kind].length > 0 && (
              <div className="grid grid-cols-2 gap-1.5">{DIM_FIELDS[cur.kind].map(([k, l]) => <Field key={k} label={`${l} [mm]`}><NumInput value={cur.dims[k]} allowNull={false} min={0} onChange={(v) => upd({ dims: { ...cur.dims, [k]: Math.max(1e-3, v ?? 1) } })} /></Field>)}</div>
            )}
            {(cur.kind === 'polygon' || cur.kind === 'extrusion' || cur.kind === 'line') && (
              <Field label="Vertices x, y [mm] (one per line)">
                <textarea className="h-20 w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-[11px] dark:border-neutral-700 dark:bg-neutral-950" defaultValue={(cur.points ?? []).map((p) => p.join(', ')).join('\n')}
                  onBlur={(e) => { const pts = e.target.value.split('\n').map((l) => l.split(/[,;\s]+/).map(Number)).filter((r) => r.length >= 2 && r.every(Number.isFinite)).map((r) => [r[0], r[1]] as [number, number]); if (pts.length >= (cur.kind === 'line' ? 2 : 3)) upd({ points: pts }) }} />
              </Field>
            )}
            {(['position', 'rotation', 'scale'] as const).map((k) => (
              <div key={k}>
                <div className="mb-0.5 text-[11px] font-medium text-neutral-500">{k === 'position' ? 'Position [mm]' : k === 'rotation' ? 'Rotation [°] about x, y, z' : 'Scale [–]'}</div>
                <div className="grid grid-cols-3 gap-1">{[0, 1, 2].map((i) => <NumInput key={i} value={cur[k][i]} allowNull={false} onChange={(v) => { const a = [...cur[k]] as [number, number, number]; a[i] = v ?? (k === 'scale' ? 1 : 0); upd({ [k]: a }) }} />)}</div>
              </div>
            ))}
            <Field label="Material assignment">
              <Select value={cur.material ? `${cur.material.type}:${cur.material.id}` : ''} onChange={(e) => { const [type, ...id] = e.target.value.split(':'); upd({ material: e.target.value ? { type: type as 'material' | 'formulation', id: id.join(':') } : null }) }}>
                <option value="">— unassigned —</option>
                <optgroup label="Project formulations">{formulations.map((f) => <option key={f.id} value={`formulation:${f.id}`}>{f.name}</option>)}</optgroup>
                <optgroup label="Library materials">{mats.map((x) => <option key={x.id} value={`material:${x.id}`}>{x.name}</option>)}</optgroup>
              </Select>
            </Field>
            <Field label="Display colour"><input type="color" value={cur.color ?? '#9ca3af'} onChange={(e) => upd({ color: e.target.value })} className="h-7 w-16 rounded border border-neutral-300" /></Field>
            {m && (
              <div className="rounded border border-neutral-200 p-2 dark:border-white/10">
                <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-neutral-500">Measurements <Prov kind="calculated" /></div>
                {m.volume !== null && <div>Volume: <b className="num">{fmtSci(m.volume, 5)}</b> mm³ ({fmtSci(m.volume / 1000, 4)} cm³)</div>}
                <div>{IS_3D[cur.kind] ? 'Surface area' : 'Area'}: <b className="num">{fmtSci(m.area, 5)}</b> mm²</div>
                <div className="text-[10px] text-neutral-500">{m.method}</div>
              </div>
            )}
            {cur.kind === 'stl' && <Alert>STL geometry is a triangle mesh; volume assumes a closed, consistently oriented mesh. Dimensions are taken as millimetres.</Alert>}
          </div>
        ) : <p className="text-xs text-neutral-500">Select an object in the graphics window or the geometry tree to edit its dimensions, transform and material.</p>}
      </Inspector>
    </div>
  )
}
