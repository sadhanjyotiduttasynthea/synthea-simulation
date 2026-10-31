import { Archive, ChevronDown, ChevronRight, Download, FolderPlus, GitBranch, LibraryBig, Pencil, Plus, Search, Tag, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plot } from '../components/Plot'
import { PropertyEditor } from '../components/PropertyEditor'
import { Alert, Badge, Button, Field, Input, Modal, PageHeader, Panel, Select, Tabs, cx, inputCls } from '../components/ui'
import { api, download, readFile } from '../lib/api'
import { fmtSci } from '../lib/format'
import { type Library, type Material, type PropertyRecord, STATUS_STYLE, condText, unitLabel, useCatalog } from '../lib/sci'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector } from '../workspace/Slots'
import { log, useWs } from '../workspace/wsStore'

type Tab = 'properties' | 'compare' | 'models' | 'history'
interface MaterialDetail extends Material { properties: PropertyRecord[]; models: { id: string; name: string; status: string; latex?: string }[] }
interface CompareRes { property: { key: string; label: string; unit: string | null }; records: (PropertyRecord & { citation?: string })[]; conflicts: { a: string; b: string; message: string }[]; condition_keys: string[]; policy: string }

const CATEGORIES = ['Protein', 'Starch', 'Hydrocolloid', 'Lipid', 'Fibre', 'Sugar', 'Mineral', 'Solvent', 'Formulation', 'Other']

export default function Libraries() {
  const { toast } = useStore()
  const catalog = useCatalog()
  const select = useWs((s) => s.select)
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const [libs, setLibs] = useState<Library[]>([])
  const [mats, setMats] = useState<Material[]>([])
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [libId, setLibId] = useState<string | null>(params.get('lib'))
  const [folderId, setFolderId] = useState<string | null>(null)
  const [openLibs, setOpenLibs] = useState<Record<string, boolean>>({})
  const [matId, setMatId] = useState<string | null>(params.get('mat'))
  const [detail, setDetail] = useState<MaterialDetail | null>(null)
  const [tab, setTab] = useState<Tab>('properties')
  const [editProp, setEditProp] = useState<PropertyRecord | null>(null)
  const [editMat, setEditMat] = useState<Material | null>(null)
  const [dialog, setDialog] = useState<null | { kind: 'library' | 'folder' | 'rename'; value: string; lib?: Library }>(null)
  const [papers, setPapers] = useState<{ id: string; title: string }[]>([])

  const loadLibs = useCallback(() => api.get<Library[]>('/api/libraries').then(setLibs), [])
  const loadMats = useCallback(() => {
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (libId) qs.set('library_id', libId)
    if (tag) qs.set('tag', tag)
    return api.get<Material[]>(`/api/materials?${qs}`).then(setMats)
  }, [q, libId, tag])
  const loadDetail = useCallback(() => {
    if (!matId) return setDetail(null)
    api.get<MaterialDetail>(`/api/materials/${matId}`).then(setDetail).catch(() => setDetail(null))
  }, [matId])
  useEffect(() => { loadLibs() }, [loadLibs])
  useEffect(() => { const t = setTimeout(loadMats, 150); return () => clearTimeout(t) }, [loadMats])
  useEffect(() => { loadDetail() }, [loadDetail])
  useEffect(() => { api.get<{ id: string; metadata?: { title?: string }; name?: string }[]>('/api/papers', true).then((ps) => setPapers(ps.map((p) => ({ id: p.id, title: p.metadata?.title || p.name || p.id })))).catch(() => setPapers([])) }, [])
  useEffect(() => { setLibId(params.get('lib')) }, [params])
  useEffect(() => { if (detail) select({ kind: 'material', id: detail.id, label: detail.name }) }, [detail, select])

  const lib = libs.find((l) => l.id === libId)
  const shown = folderId && lib ? mats.filter((m) => m.folders?.[lib.id] === folderId) : mats
  const allTags = useMemo(() => [...new Set(mats.flatMap((m) => m.tags))].sort(), [mats])

  const newMaterial = () => setEditMat({ id: '', name: 'New material', category: 'Other', library_ids: libId ? [libId] : [], tags: [], synonyms: [], folders: libId && folderId ? { [libId]: folderId } : {} })
  useCommand('library.new', () => setDialog({ kind: 'library', value: '' }))
  useCommand('material.new', newMaterial)
  useCommand('library.import', () => importLib())

  const saveLibrary = async () => {
    if (!dialog) return
    try {
      if (dialog.kind === 'library') {
        const l = await api.post<Library>('/api/libraries', { name: dialog.value })
        setLibId(l.id)
        log('success', 'library', `Created library ${l.name}`)
      } else if (dialog.kind === 'rename' && dialog.lib) {
        await api.put(`/api/libraries/${dialog.lib.id}`, { ...dialog.lib, name: dialog.value })
      } else if (dialog.kind === 'folder' && dialog.lib) {
        await api.put(`/api/libraries/${dialog.lib.id}`, { ...dialog.lib, folders: [...dialog.lib.folders, { id: `f-${Date.now().toString(36)}`, name: dialog.value }] })
        setOpenLibs({ ...openLibs, [dialog.lib.id]: true })
      }
      setDialog(null)
      await loadLibs()
      refreshTree()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const archive = async (l: Library) => {
    if (!confirm(`Archive library "${l.name}"? Materials remain in the global database and in other libraries.`)) return
    await api.put(`/api/libraries/${l.id}`, { ...l, archived: true })
    if (libId === l.id) setLibId(null)
    await loadLibs()
    refreshTree()
  }
  const exportLib = async (l: Library) => {
    const b = await api.get<unknown>(`/api/libraries/${l.id}/export`)
    await download(`${l.name.replace(/\W+/g, '_')}.synthea-library.json`, JSON.stringify(b, null, 2))
    log('success', 'library', `Exported ${l.name}`)
  }
  const importLib = async () => {
    try {
      const b = JSON.parse(await readFile('.json'))
      const r = await api.post<Record<string, number | string>>('/api/libraries/import', b)
      toast(`Imported: ${r.materials} new materials, ${r.merged_materials} existing materials linked, ${r.properties} property records`, 'success')
      await loadLibs()
      await loadMats()
      refreshTree()
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error')
    }
  }

  const saveMaterial = async (m: Material) => {
    try {
      const saved = m.id ? await api.put<Material>(`/api/materials/${m.id}`, m) : await api.post<Material>('/api/materials', m)
      setEditMat(null)
      setMatId(saved.id)
      await loadMats()
      await loadLibs()
      loadDetail()
      refreshTree()
      toast('Material saved', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const saveProp = async (p: PropertyRecord) => {
    try {
      if (p.id) await api.put(`/api/properties/${p.id}`, p)
      else await api.post('/api/properties', p)
      setEditProp(null)
      loadDetail()
      log('info', 'library', `${p.id ? 'Updated' : 'Added'} ${p.property} for ${detail?.name} (${p.review_status})`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Scientific Libraries"
        subtitle="Global, reusable material knowledge. Each property value carries its conditions, source and review status; conflicting reports coexist."
        actions={<>
          <Button size="sm" onClick={() => setDialog({ kind: 'library', value: '' })}><Plus className="h-3.5 w-3.5" />Library</Button>
          <Button size="sm" onClick={newMaterial}><Plus className="h-3.5 w-3.5" />Material</Button>
          <Button size="sm" onClick={importLib}><Upload className="h-3.5 w-3.5" />Import library</Button>
          {lib && <Button size="sm" onClick={() => exportLib(lib)}><Download className="h-3.5 w-3.5" />Export library</Button>}
        </>}
      />
      <div className="grid min-h-0 flex-1 gap-3 @4xl:grid-cols-[230px_minmax(0,1fr)]">
        <Panel title="Library manager" bodyClass="p-1" className="@4xl:overflow-y-auto">
          <button onClick={() => { setLibId(null); setFolderId(null); setParams({}) }} className={cx('flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs', !libId ? 'bg-neutral-900 text-white dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800')}>
            <Search className="h-3.5 w-3.5" />All libraries (global search)
          </button>
          {libs.map((l) => {
            const open = openLibs[l.id]
            return (
              <div key={l.id}>
                <div className={cx('group flex items-center gap-1 rounded px-1 py-1 text-xs', libId === l.id && !folderId ? 'bg-rose-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800')}>
                  <button onClick={() => setOpenLibs({ ...openLibs, [l.id]: !open })} className="text-neutral-400">{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</button>
                  <button className="flex flex-1 items-center gap-1.5 truncate text-left" onClick={() => { setLibId(l.id); setFolderId(null); setParams({ lib: l.id }) }}>
                    <LibraryBig className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{l.name}</span>
                  </button>
                  <span className="text-[10px] opacity-70">{l.material_count}</span>
                  <span className="hidden gap-0.5 group-hover:flex">
                    <button title="New folder" onClick={() => setDialog({ kind: 'folder', value: '', lib: l })}><FolderPlus className="h-3 w-3" /></button>
                    <button title="Rename" onClick={() => setDialog({ kind: 'rename', value: l.name, lib: l })}><Pencil className="h-3 w-3" /></button>
                    <button title="Export" onClick={() => exportLib(l)}><Download className="h-3 w-3" /></button>
                    <button title="Archive" onClick={() => archive(l)}><Archive className="h-3 w-3" /></button>
                  </span>
                </div>
                {open && l.folders.map((f) => (
                  <button key={f.id} onClick={() => { setLibId(l.id); setFolderId(f.id) }} className={cx('ml-6 flex w-[calc(100%-1.5rem)] items-center gap-1 rounded px-2 py-0.5 text-left text-[11.5px]', folderId === f.id ? 'bg-rose-600 text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800')}>📁 {f.name}</button>
                ))}
              </div>
            )
          })}
        </Panel>

        <div className="flex min-h-0 flex-col gap-3">
          <Panel title={`${lib ? lib.name : 'All libraries'}${folderId ? ' / ' + lib?.folders.find((f) => f.id === folderId)?.name : ''} — ${shown.length} materials`} bodyClass="p-0">
            <div className="flex gap-2 border-b border-neutral-200 p-2 dark:border-neutral-800">
              <div className="relative flex-1"><Search className="absolute left-2 top-1.5 h-4 w-4 text-neutral-400" /><input className={cx(inputCls, 'w-full pl-7')} placeholder="Search materials, synonyms, tags, properties across libraries…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
              <Select className="w-36" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{allTags.map((t) => <option key={t}>{t}</option>)}</Select>
            </div>
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-neutral-50 text-left text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-900"><tr><th className="px-2 py-1">Material</th><th>Category</th><th>Libraries</th><th>Tags</th><th className="text-right">Records</th><th className="text-right">Approved</th><th className="px-2 text-right">To review</th></tr></thead>
                <tbody>
                  {shown.map((m) => (
                    <tr key={m.id} onClick={() => { setMatId(m.id); setEditProp(null); setEditMat(null) }} className={cx('cursor-pointer border-t border-neutral-100 dark:border-neutral-800', m.id === matId ? 'bg-rose-50 dark:bg-rose-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40')}>
                      <td className="px-2 py-1 font-medium">{m.name}{(m.version ?? 1) > 1 && <span className="ml-1 text-[10px] text-neutral-400">v{m.version}</span>}</td>
                      <td className="text-neutral-500">{m.category}</td>
                      <td className="text-neutral-500">{m.library_names?.join(', ')}</td>
                      <td>{m.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td>
                      <td className="num text-right">{m.property_count}</td>
                      <td className="num text-right">{m.approved_count}</td>
                      <td className="num px-2 text-right">{m.pending_count ? <span className="text-amber-600">{m.pending_count}</span> : 0}</td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-neutral-500">No materials. Create one or import a library.</td></tr>}
                </tbody>
              </table>
            </div>
          </Panel>

          {detail && catalog && (
            <Panel
              title={`${detail.name} · ${detail.category}`}
              subtitle={`Libraries: ${detail.library_ids.map((i) => libs.find((l) => l.id === i)?.name ?? i).join(', ')}${detail.ingredient_id ? ` · linked to formulation ingredient “${detail.ingredient_id}”` : ''}`}
              actions={<>
                <Button size="sm" onClick={() => setEditMat(structuredClone(detail))}><Pencil className="h-3.5 w-3.5" />Edit</Button>
                <Button size="sm" onClick={async () => { const v = await api.post<Material>(`/api/materials/${detail.id}/version`); setMatId(v.id); loadMats(); toast(`Created version ${v.version}`, 'success') }}><GitBranch className="h-3.5 w-3.5" />New version</Button>
                <Button size="sm" variant="primary" onClick={() => setEditProp({ id: '', material_id: detail.id, property: 'viscosity', value: null, unit: 'Pa*s', conditions: {}, source: {}, evidence_type: 'manual_entry', review_status: 'extracted' })}><Plus className="h-3.5 w-3.5" />Property</Button>
              </>}
              className="min-h-0 flex-1" bodyClass="p-0"
            >
              <div className="px-3 pt-1"><Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'properties', label: `Properties (${detail.properties.length})` }, { id: 'compare', label: 'Compare across sources' }, { id: 'models', label: `Models (${detail.models.length})` }, { id: 'history', label: 'History' }]} /></div>
              <div className="p-3">
                {tab === 'properties' && <PropertyTable detail={detail} catalog={catalog} onSelect={(p) => setEditProp(p)} selected={editProp?.id} />}
                {tab === 'compare' && <ComparePanel detail={detail} />}
                {tab === 'models' && (
                  detail.models.length === 0 ? <p className="text-xs text-neutral-500">No models linked to this material. Approved equations extracted from papers or created in the Model Registry appear here.</p> : (
                    <table className="w-full text-xs"><tbody>{detail.models.map((m) => <tr key={m.id} className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 dark:border-neutral-800" onClick={() => nav(`/models?model=${m.id}`)}><td className="py-1">{m.name}</td><td><span className={cx('rounded px-1.5 text-[10px] uppercase', STATUS_STYLE[m.status])}>{m.status}</span></td></tr>)}</tbody></table>
                  )
                )}
                {tab === 'history' && (
                  <ul className="space-y-1 text-xs">
                    {(detail.history ?? []).slice().reverse().map((h, i) => <li key={i}><span className="text-neutral-400">{new Date(h.t).toLocaleString()}</span> — {h.note}</li>)}
                    {detail.previous_version_id && <li>Previous version: <button className="text-rose-600 underline" onClick={() => setMatId(detail.previous_version_id!)}>{detail.previous_version_id}</button></li>}
                  </ul>
                )}
              </div>
            </Panel>
          )}
          {!detail && <Panel><p className="py-6 text-center text-xs text-neutral-500">Select a material to see its condition-aware property records, compare sources and linked models.</p></Panel>}
        </div>
      </div>

      <Inspector>
        {editProp && catalog ? (
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{editProp.id ? 'Property record' : 'New property record'}</div>
            <PropertyEditor record={editProp} catalog={catalog} papers={papers} onSave={saveProp} onCancel={() => setEditProp(null)}
              onDelete={editProp.id ? async () => { await api.del(`/api/properties/${editProp.id}`); setEditProp(null); loadDetail() } : undefined} />
            {editProp.quality && <div className="mt-2 text-[11px] text-neutral-500">Quality indicator {editProp.quality.score}/100 {editProp.quality.flags.length > 0 && `· ${editProp.quality.flags.join(', ')}`}</div>}
            {editProp.history && editProp.history.length > 1 && <details className="mt-2 text-[11px]"><summary className="cursor-pointer text-neutral-500">Version history ({editProp.history.length})</summary>{editProp.history.slice().reverse().map((h, i) => <div key={i}>{new Date(h.t).toLocaleString()} — {h.note}{h.changed?.length ? `: ${h.changed.join(', ')}` : ''}</div>)}</details>}
          </div>
        ) : editMat ? (
          <MaterialEditor m={editMat} libs={libs} onSave={saveMaterial} onCancel={() => setEditMat(null)} />
        ) : detail ? (
          <div className="space-y-2 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Material</div>
            <div className="text-sm font-semibold">{detail.name}</div>
            <div>Synonyms: {detail.synonyms.join(', ') || '—'}</div>
            <div className="flex flex-wrap gap-1"><Tag className="h-3.5 w-3.5" />{detail.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
            {Object.entries(detail.identity ?? {}).filter(([, v]) => v).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
            <p className="text-neutral-500">Select a property row to edit or review it.</p>
          </div>
        ) : null}
      </Inspector>

      <Modal open={!!dialog} onClose={() => setDialog(null)} title={dialog?.kind === 'library' ? 'New scientific library' : dialog?.kind === 'folder' ? `New folder in ${dialog.lib?.name}` : 'Rename library'} footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" onClick={saveLibrary}>OK</Button></>}>
        <Field label="Name"><Input autoFocus className="w-full" value={dialog?.value ?? ''} onChange={(e) => setDialog(dialog && { ...dialog, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveLibrary()} /></Field>
      </Modal>
    </div>
  )
}

function PropertyTable({ detail, catalog, onSelect, selected }: { detail: MaterialDetail; catalog: NonNullable<ReturnType<typeof useCatalog>>; onSelect: (p: PropertyRecord) => void; selected?: string }) {
  const condLabels = Object.fromEntries(catalog.conditions.map((c) => [c.key, c]))
  const groups = Object.entries(catalog.categories).map(([cat, label]) => ({ cat, label, rows: detail.properties.filter((p) => (p.category ?? 'model') === cat) })).filter((g) => g.rows.length)
  if (!detail.properties.length) return <p className="text-xs text-neutral-500">No property records yet. Add one manually or import a research paper and approve extracted values.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-[10px] uppercase tracking-wide text-neutral-500"><tr><th className="py-1">Property</th><th className="text-right">Value</th><th>Unit</th><th className="text-right">Normalised</th><th className="pl-2">Conditions</th><th>Source</th><th>Evidence</th><th>Status</th><th className="text-right">Q</th></tr></thead>
        <tbody>
          {groups.map((g) => [
            <tr key={g.cat}><td colSpan={9} className="pt-2 text-[10px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400">{g.label}</td></tr>,
            ...g.rows.map((p) => (
              <tr key={p.id} onClick={() => onSelect(p)} className={cx('cursor-pointer border-t border-neutral-100 dark:border-neutral-800', p.id === selected ? 'bg-rose-50 dark:bg-rose-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/40', p.review_status === 'rejected' && 'opacity-50')}>
                <td className="py-1 pr-2">{p.label ?? p.property}</td>
                <td className="num text-right">{p.value_text && p.value === null ? <i>{p.value_text}</i> : <>{fmtSci(p.value, 4)}{p.value_max !== null && p.value_max !== undefined ? `–${fmtSci(p.value_max, 4)}` : ''}{p.uncertainty?.value ? ` ± ${fmtSci(p.uncertainty.value, 3)}` : ''}</>}</td>
                <td className="pl-1 text-neutral-500">{unitLabel(p.unit)}</td>
                <td className="num text-right text-neutral-500">{p.normalized?.ok ? `${fmtSci(p.normalized.value, 4)} ${unitLabel(p.normalized.unit)}` : p.normalized ? <span className="text-red-600" title={p.normalized.note ?? ''}>unit?</span> : '—'}</td>
                <td className="max-w-[220px] truncate pl-2 text-neutral-600 dark:text-neutral-400" title={condText(p.conditions, condLabels)}>{condText(p.conditions, condLabels) || <span className="text-amber-600">not stated</span>}</td>
                <td className="max-w-[200px] truncate" title={p.source?.snippet}>{p.source?.citation ?? (p.source?.paper_id ? 'paper' : '—')}{p.source?.page ? ` p.${p.source.page}` : ''}</td>
                <td className="whitespace-nowrap text-neutral-500">{(p.evidence_type ?? '').replace(/_/g, ' ')}</td>
                <td><span className={cx('rounded px-1.5 py-px text-[10px] font-semibold uppercase', STATUS_STYLE[p.review_status])}>{p.review_status}</span></td>
                <td className="num text-right text-neutral-500" title={p.quality?.flags.join(', ')}>{p.quality?.score ?? '—'}</td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  )
}

function ComparePanel({ detail }: { detail: MaterialDetail }) {
  const keys = [...new Set(detail.properties.filter((p) => p.value !== null).map((p) => p.property))]
  const [prop, setProp] = useState(keys.includes('viscosity') ? 'viscosity' : keys[0])
  const [xKey, setXKey] = useState<string>('')
  const [res, setRes] = useState<CompareRes | null>(null)
  useEffect(() => { if (prop) api.get<CompareRes>(`/api/properties/compare?material_id=${detail.id}&property=${prop}`).then((r) => { setRes(r); setXKey(r.condition_keys[0] ?? '') }) }, [prop, detail])
  if (!keys.length) return <p className="text-xs text-neutral-500">No numeric property records to compare.</p>
  const recs = res?.records.filter((r) => r.normalized?.ok) ?? []
  const bySource = new Map<string, typeof recs>()
  recs.forEach((r) => { const k = r.citation ?? r.source?.paper_id ?? 'unsourced'; bySource.set(k, [...(bySource.get(k) ?? []), r]) })
  const traces = [...bySource.entries()].map(([src, rs]) => ({
    type: 'scatter' as const, mode: 'markers' as const, name: src.length > 40 ? src.slice(0, 40) + '…' : src,
    x: rs.map((r, i) => (xKey ? Number(r.conditions?.[xKey]) : i + 1)), y: rs.map((r) => r.normalized!.value),
    error_y: { type: 'data' as const, array: rs.map((r) => (r.uncertainty?.type === 'sd' || r.uncertainty?.type === 'se' ? r.uncertainty?.value ?? 0 : 0)), visible: true },
    marker: { size: 9, symbol: rs.map((r) => (r.review_status === 'approved' ? 'circle' : 'circle-open')) },
    text: rs.map((r) => `${r.review_status} · ${r.evidence_type}`),
  }))
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Field label="Property"><Select value={prop} onChange={(e) => setProp(e.target.value)}>{keys.map((k) => <option key={k} value={k}>{detail.properties.find((p) => p.property === k)?.label ?? k}</option>)}</Select></Field>
        <Field label="X axis (condition)"><Select value={xKey} onChange={(e) => setXKey(e.target.value)}><option value="">record index</option>{res?.condition_keys.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
        <span className="mt-4 text-[11px] text-neutral-500">Filled = approved, open = not yet approved. Error bars: reported SD/SE.</span>
      </div>
      {res?.conflicts.map((c, i) => <Alert key={i} kind="warn" title="Conflicting reports">{c.message} Both records are kept; check the methods and sample histories.</Alert>)}
      <Plot data={traces} layout={{ xaxis: { title: { text: xKey || 'record' } }, yaxis: { title: { text: `${res?.property.label ?? ''} [${unitLabel(res?.property.unit) || '–'}]` } } }} height={260} />
      <table className="w-full text-xs">
        <thead className="text-left text-[10px] uppercase text-neutral-500"><tr><th>Source</th><th className="text-right">Normalised value</th><th className="pl-2">Conditions</th><th>Method</th><th>Status</th></tr></thead>
        <tbody>{res?.records.map((r) => <tr key={r.id} className="border-t border-neutral-100 dark:border-neutral-800"><td className="py-0.5">{r.citation ?? '—'}{r.source?.page ? ` p.${r.source.page}` : ''}</td><td className="num text-right">{r.normalized?.ok ? `${fmtSci(r.normalized.value, 4)} ${unitLabel(r.normalized.unit)}` : '—'}</td><td className="pl-2">{condText(r.conditions)}</td><td>{r.method}</td><td>{r.review_status}</td></tr>)}</tbody>
      </table>
      <p className="text-[10px] text-neutral-500">{res?.policy}</p>
    </div>
  )
}

function MaterialEditor({ m, libs, onSave, onCancel }: { m: Material; libs: Library[]; onSave: (m: Material) => void; onCancel: () => void }) {
  const [d, setD] = useState(m)
  useEffect(() => setD(m), [m])
  return (
    <div className="space-y-2 text-xs">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{m.id ? 'Edit material' : 'New material'}</div>
      <Field label="Name"><Input className="w-full" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
      <Field label="Category"><Select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
      <Field label="Synonyms (comma separated)"><Input className="w-full" value={d.synonyms.join(', ')} onChange={(e) => setD({ ...d, synonyms: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
      <Field label="Tags (comma separated)"><Input className="w-full" value={d.tags.join(', ')} onChange={(e) => setD({ ...d, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
      <Field label="Botanical / chemical identity"><Input className="w-full" value={d.identity?.source ?? ''} onChange={(e) => setD({ ...d, identity: { ...d.identity, source: e.target.value } })} /></Field>
      <Field label="Processing history / grade"><Input className="w-full" value={d.identity?.processing ?? ''} onChange={(e) => setD({ ...d, identity: { ...d.identity, processing: e.target.value } })} placeholder="e.g. wet-extracted isolate, spray-dried" /></Field>
      <div>
        <div className="mb-0.5 text-[11px] font-medium text-neutral-500">Libraries (one global record, placed in several libraries)</div>
        {libs.map((l) => (
          <label key={l.id} className="flex items-center gap-1.5"><input type="checkbox" checked={d.library_ids.includes(l.id)} onChange={(e) => setD({ ...d, library_ids: e.target.checked ? [...d.library_ids, l.id] : d.library_ids.filter((x) => x !== l.id) })} />{l.name}
            {d.library_ids.includes(l.id) && l.folders.length > 0 && (
              <select className="ml-auto h-5 rounded border border-neutral-300 text-[10px] dark:border-neutral-700 dark:bg-neutral-950" value={d.folders?.[l.id] ?? ''} onChange={(e) => setD({ ...d, folders: { ...d.folders, [l.id]: e.target.value } })}>
                <option value="">(no folder)</option>{l.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            )}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-1 pt-1">
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        {m.id && <Button size="sm" onClick={() => onSave({ ...d, archived: true })}><Archive className="h-3.5 w-3.5" />Archive</Button>}
        <Button size="sm" variant="primary" onClick={() => onSave(d)}>Save</Button>
      </div>
      {!d.library_ids.length && <Alert kind="warn">Not placed in any library; it will still be searchable under “All libraries”.</Alert>}
    </div>
  )
}
