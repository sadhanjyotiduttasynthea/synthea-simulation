import { Bot, Check, CheckCheck, Cpu, FilePlus2, RotateCcw, ShieldAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Equation } from '../components/Equation'
import { EquationEditor } from '../components/EquationEditor'
import { PageViewer } from '../components/PageViewer'
import { Alert, Badge, Button, Field, Input, Modal, NumInput, Select, Spinner, cx } from '../components/ui'
import { api } from '../lib/api'
import { fmtSci } from '../lib/format'
import { type Catalog, type Library, type Material, condText, unitLabel, useCatalog } from '../lib/sci'
import { useStore } from '../store'
import { Inspector } from '../workspace/Slots'
import { log } from '../workspace/wsStore'
import type { Paper } from './Papers'

interface EqParam { symbol: string; latex?: string; name: string; unit: string; value: number | null; value_unit?: string | null; source_text?: string | null; property?: string }
interface Candidate {
  id: string; kind: 'property' | 'equation'; status: 'pending' | 'approved' | 'rejected'; extractor: string; confidence: string
  property?: string; label?: string; value?: number | null; value_max?: number | null; value_text?: string; unit?: string; uncertainty?: { type?: string; value?: number | null }; n?: number | null
  conditions?: Record<string, number | null>; page: number; snippet: string; table_ref?: string; evidence_type: string; material_name?: string; material_id?: string
  normalized?: { value: number | null; unit: string; ok: boolean; note: string | null } | null; notes?: string; method?: string; composition?: string
  verification?: { snippet_on_page: boolean; value_in_snippet: boolean | null; notes: string[] }
  equation?: { name: string; latex: string; expression: string; raw: string; template: string | null; parameters?: EqParam[]; parameter_sets?: { page: number; table_ref: string; conditions: Record<string, number>; parameters: Record<string, { value: number; unit: string }>; r2?: number }[]; validity?: Record<string, number[]>; variables?: { symbol: string; name: string; unit: string }[]; dependent?: { symbol: string; name: string; unit: string } }
  approved_as?: { type: string; id: string }[]; fit_r2?: number
}
interface AiSettings { allow_external_ai: boolean; api_key_configured: boolean; model: string }

const CONF: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = { high: 'green', medium: 'amber', low: 'red', manual: 'neutral' }

export function ExtractionReview({ paper, onChanged }: { paper: Paper; onSource: (page: number, snippet?: string | null) => void; page: number; highlight: string | null; onPage: (n: number) => void; onChanged: () => void }) {
  const catalog = useCatalog()
  const { toast } = useStore()
  const [cands, setCands] = useState<Candidate[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')
  const [busy, setBusy] = useState<string | null>(null)
  const [mats, setMats] = useState<Material[]>([])
  const [libs, setLibs] = useState<Library[]>([])
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [viewPage, setViewPage] = useState(1)
  const [summary, setSummary] = useState<{ materials?: { name: string; mentions: number }[]; abbreviations?: Record<string, string> } | null>(null)

  const load = useCallback(() => api.get<Candidate[]>(`/api/papers/${paper.id}/extractions`).then(setCands), [paper.id])
  useEffect(() => { load(); api.get<Material[]>('/api/materials').then(setMats); api.get<Library[]>('/api/libraries').then(setLibs); api.get<AiSettings>('/api/settings/ai').then(setAi) }, [load])
  const shown = useMemo(() => cands.filter((c) => filter === 'all' || c.status === filter), [cands, filter])
  const cur = cands.find((c) => c.id === sel) ?? null
  useEffect(() => { if (cur) setViewPage(cur.page) }, [cur?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (method: 'rule' | 'ai') => {
    setBusy(method === 'ai' ? `Sending document text to ${ai?.model}…` : 'Running local extraction…')
    try {
      const r = await api.post<{ created: number; extractor: string; summary: { properties: number; equations: number; flagged: number }; materials: { name: string; mentions: number }[]; abbreviations: Record<string, string> }>('/api/extractions/run', { paper_id: paper.id, method })
      setSummary(r)
      log('success', 'extraction', `${r.extractor}: ${r.summary.properties} property and ${r.summary.equations} equation candidates (${r.summary.flagged} flagged by source verification). Review required.`)
      await load()
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const act = async (c: Candidate, action: 'approve' | 'reject' | 'reopen', body: Record<string, unknown> = {}) => {
    try {
      const r = await api.post<{ created?: { type: string; id: string }[] }>(`/api/extractions/${c.id}/${action}`, body)
      if (action === 'approve') log('success', 'review', `Approved ${c.label ?? c.equation?.name} (p. ${c.page}) → ${r.created?.map((x) => `${x.type} ${x.id}`).join(', ')}`)
      else log('info', 'review', `${action === 'reject' ? 'Rejected' : 'Re-opened'} ${c.label ?? c.equation?.name}`)
      await load()
      onChanged()
      const next = cands.find((x) => x.status === 'pending' && x.id !== c.id)
      setSel(next?.id ?? null)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const save = async (c: Candidate, patch: Partial<Candidate>) => {
    const r = await api.put<Candidate>(`/api/extractions/${c.id}`, patch)
    setCands(cands.map((x) => (x.id === c.id ? r : x)))
  }
  const bulk = async (action: 'approve' | 'reject', status = 'reviewed') => {
    const items = cands.filter((c) => checked.includes(c.id) && c.status === 'pending')
    for (const c of items) {
      try { await api.post(`/api/extractions/${c.id}/${action}`, action === 'approve' ? { review_status: status, material_id: c.material_id } : {}) } catch (e) { toast(`${c.label}: ${(e as Error).message}`, 'error') }
    }
    log('info', 'review', `${action === 'approve' ? 'Approved' : 'Rejected'} ${items.length} candidate(s) in bulk`)
    setChecked([])
    await load()
    onChanged()
  }
  const addManual = async () => {
    const c = await api.post<Candidate>('/api/extractions', { paper_id: paper.id, kind: 'property', property: 'viscosity', label: 'Apparent viscosity', value: null, unit: 'Pa·s', page: viewPage, snippet: '', evidence_type: 'directly_reported', conditions: {} })
    await load()
    setFilter('pending')
    setSel(c.id)
  }

  const counts = { pending: cands.filter((c) => c.status === 'pending').length, approved: cands.filter((c) => c.status === 'approved').length, rejected: cands.filter((c) => c.status === 'rejected').length }
  const pageW = paper.pages?.[viewPage - 1]?.width ?? 595

  return (
    <div className="grid h-full min-h-[480px] grid-cols-1 @2xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <div className="flex min-h-0 flex-col border-r border-neutral-200 dark:border-white/10">
        <div className="flex flex-wrap items-center gap-1 border-b border-neutral-200 p-2 dark:border-white/10">
          <Button size="sm" variant="primary" onClick={() => run('rule')} disabled={!!busy}><Cpu className="h-3.5 w-3.5" />Extract (local)</Button>
          <Button size="sm" onClick={() => run('ai')} disabled={!!busy || !ai?.api_key_configured || !ai?.allow_external_ai}
            title={!ai?.api_key_configured ? 'No API key configured on this machine' : !ai?.allow_external_ai ? 'Enable external AI in Settings → AI assistant' : `Sends document text to ${ai.model}`}><Bot className="h-3.5 w-3.5" />Extract with AI</Button>
          <Button size="sm" variant="ghost" onClick={addManual}><FilePlus2 className="h-3.5 w-3.5" />Manual entry</Button>
          <div className="flex-1" />
          <Select className="w-32" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="pending">To review ({counts.pending})</option><option value="approved">Approved ({counts.approved})</option><option value="rejected">Rejected ({counts.rejected})</option><option value="all">All ({cands.length})</option>
          </Select>
        </div>
        {busy && <div className="p-2"><Spinner label={busy} /></div>}
        {!ai?.allow_external_ai && <div className="px-2 pt-2 text-[10.5px] text-neutral-500">Local extraction runs entirely on this computer. AI extraction is off{ai?.api_key_configured ? '' : ' (no API key configured)'}; document text is never sent externally unless you enable it in Settings.</div>}
        {checked.length > 0 && (
          <div className="flex items-center gap-1 border-b border-neutral-200 bg-amber-50 px-2 py-1 text-xs dark:border-white/10 dark:bg-amber-950/30">
            {checked.length} selected
            <Button size="sm" onClick={() => bulk('approve', 'reviewed')}><Check className="h-3.5 w-3.5" />Mark reviewed</Button>
            <Button size="sm" onClick={() => bulk('approve', 'approved')}><CheckCheck className="h-3.5 w-3.5" />Approve</Button>
            <Button size="sm" variant="ghost" onClick={() => bulk('reject')}><X className="h-3.5 w-3.5" />Reject</Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {cands.length === 0 && !busy && <p className="p-4 text-center text-xs text-neutral-500">No extraction yet. Run the local extractor, enable AI extraction, or enter values manually.</p>}
          <table className="w-full text-xs">
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} onClick={() => setSel(c.id)} className={cx('cursor-pointer border-b border-neutral-100 align-top dark:border-white/5', c.id === sel ? 'bg-rose-50 dark:bg-rose-950/30' : 'hover:bg-neutral-50 dark:hover:bg-white/5')}>
                  <td className="w-6 py-1.5 pl-2"><input type="checkbox" checked={checked.includes(c.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setChecked(e.target.checked ? [...checked, c.id] : checked.filter((x) => x !== c.id))} disabled={c.status !== 'pending'} /></td>
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1 font-medium">{c.kind === 'equation' ? <span className="text-cyan-700 dark:text-cyan-400">∑ {c.equation?.name}</span> : c.label}
                      {c.verification?.notes.length ? <span title={c.verification.notes.join('; ')}><ShieldAlert className="h-3.5 w-3.5 text-red-600" /></span> : null}</div>
                    {c.kind === 'property' ? (
                      <div className="num">{c.value !== null && c.value !== undefined ? fmtSci(c.value, 4) : '—'}{c.uncertainty?.value ? ` ± ${c.uncertainty.value}` : ''} {unitLabel(c.unit)} <span className="text-neutral-500">{condText(c.conditions as Record<string, number>)}</span></div>
                    ) : (
                      <div className="text-neutral-500">{c.equation?.parameter_sets?.length ? `${c.equation.parameter_sets.length} fitted parameter sets` : c.equation?.raw}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-right">
                    <div>p.{c.page}</div>
                    <Badge tone={CONF[c.confidence] ?? 'neutral'}>{c.confidence}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex min-h-0 flex-col">
        {cur && catalog ? (
          <div className="max-h-[52%] shrink-0 overflow-auto border-b border-neutral-200 p-2 dark:border-white/10">
            <CandidateEditor key={cur.id} c={cur} catalog={catalog} mats={mats} libs={libs} onSave={(p) => save(cur, p)} onAct={(a, b) => act(cur, a, b)} />
          </div>
        ) : <div className="p-3 text-xs text-neutral-500">Select a candidate to see its source passage and review it.</div>}
        <div className="min-h-0 flex-1">
          {paper.pages && <PageViewer paperId={paper.id} page={viewPage} pageCount={paper.page_count} pageWidth={pageW} highlight={cur && cur.page === viewPage ? (cur.table_ref ? cur.snippet.split(' | ')[0] : cur.snippet) : null} onPage={setViewPage} />}
        </div>
      </div>

      <Inspector>
        <div className="space-y-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Review workflow</div>
          <ol className="list-decimal space-y-0.5 pl-4 text-neutral-600 dark:text-neutral-400">
            <li>PDF text & tables extracted locally</li><li>Extractor proposes candidates</li><li>Source verification (passage on page, value in passage)</li><li>You review, correct and assign the material</li><li>Approved records enter the library with their source</li>
          </ol>
          {summary?.materials && summary.materials.length > 0 && <div><b>Materials mentioned:</b> {summary.materials.map((m) => `${m.name} (${m.mentions})`).join(', ')}</div>}
          {summary?.abbreviations && Object.keys(summary.abbreviations).length > 0 && <div><b>Abbreviations:</b> {Object.entries(summary.abbreviations).map(([k, v]) => `${k} = ${v}`).join('; ')}</div>}
          <Alert>Approval as <b>reviewed</b> stores the record but it is not used in simulations; <b>approved</b> records and models can be selected by digital twins. A reviewed equation is not automatically validated.</Alert>
        </div>
      </Inspector>
    </div>
  )
}

function MaterialPicker({ c, mats, libs, value, onChange }: { c: Candidate; mats: Material[]; libs: Library[]; value: { material_id?: string; new_material?: { name: string; library_ids: string[] } }; onChange: (v: { material_id?: string; new_material?: { name: string; library_ids: string[] } }) => void }) {
  const isNew = !!value.new_material
  return (
    <div className="rounded border border-neutral-200 p-1.5 dark:border-white/10">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-neutral-500">Material <span className="text-neutral-400">(suggested: {c.material_name ?? 'none'})</span></div>
      <div className="flex gap-1">
        <Select value={isNew ? '__new' : value.material_id ?? ''} onChange={(e) => e.target.value === '__new' ? onChange({ new_material: { name: c.material_name ?? '', library_ids: [] } }) : onChange({ material_id: e.target.value })}>
          <option value="">— select —</option>
          {mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          <option value="__new">+ New material…</option>
        </Select>
      </div>
      {isNew && (
        <div className="mt-1 space-y-1">
          <Input className="w-full" placeholder="Material name, e.g. Pea protein isolate (wet-extracted)" value={value.new_material!.name} onChange={(e) => onChange({ new_material: { ...value.new_material!, name: e.target.value } })} />
          <div className="flex flex-wrap gap-x-3 text-[11px]">{libs.map((l) => <label key={l.id} className="flex items-center gap-1"><input type="checkbox" checked={value.new_material!.library_ids.includes(l.id)} onChange={(e) => onChange({ new_material: { ...value.new_material!, library_ids: e.target.checked ? [...value.new_material!.library_ids, l.id] : value.new_material!.library_ids.filter((x) => x !== l.id) } })} />{l.name}</label>)}</div>
        </div>
      )}
    </div>
  )
}

function CandidateEditor({ c, catalog, mats, libs, onSave, onAct }: { c: Candidate; catalog: Catalog; mats: Material[]; libs: Library[]; onSave: (p: Partial<Candidate>) => Promise<void>; onAct: (a: 'approve' | 'reject' | 'reopen', b?: Record<string, unknown>) => void }) {
  const [d, setD] = useState<Candidate>(c)
  const [mat, setMat] = useState<{ material_id?: string; new_material?: { name: string; library_ids: string[] } }>({ material_id: c.material_id })
  const [sets, setSets] = useState<number[]>(() => (c.equation?.parameter_sets ?? []).map((_, i) => i))
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const dirty = JSON.stringify(d) !== JSON.stringify(c)
  const condLabels = Object.fromEntries(catalog.conditions.map((x) => [x.key, x]))
  const ro = c.status !== 'pending'
  const approve = async (status: 'reviewed' | 'approved') => {
    if (dirty) await onSave(d)
    onAct('approve', { review_status: status, ...mat, ...(c.kind === 'equation' ? { parameter_sets: sets, latex: d.equation?.latex } : {}) })
  }
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold">{c.kind === 'equation' ? c.equation?.name : c.label}</span>
        <Badge>{c.extractor}</Badge><Badge tone={CONF[c.confidence] ?? 'neutral'}>confidence: {c.confidence}</Badge>
        <span className={cx('rounded px-1.5 text-[10px] font-semibold uppercase', c.status === 'approved' ? 'bg-emerald-600 text-white' : c.status === 'rejected' ? 'bg-neutral-400 text-white' : 'bg-amber-500 text-white')}>{c.status}</span>
      </div>
      {c.verification?.notes.length ? <Alert kind="error" title="Source verification failed">{c.verification.notes.join('; ')}. Correct the value or passage against the document before approving.</Alert>
        : <div className="text-[11px] text-emerald-700 dark:text-emerald-400">✓ Passage found on page {c.page}{c.kind === 'property' ? '; value present in passage' : ''}.</div>}
      <div className="rounded bg-neutral-100 p-1.5 text-[11px] italic text-neutral-700 dark:bg-white/5 dark:text-neutral-300">“{c.snippet}”{c.table_ref && <div className="not-italic text-neutral-500">{c.table_ref}</div>}</div>

      {c.kind === 'property' ? (
        <>
          <div className="grid grid-cols-[1.6fr_1fr_0.8fr_1fr] gap-1.5">
            <Field label="Property">
              <Select disabled={ro} value={d.property} onChange={(e) => setD({ ...d, property: e.target.value })}>
                {Object.entries(catalog.categories).map(([cat, l]) => <optgroup key={cat} label={l}>{catalog.properties.filter((p) => p.category === cat).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</optgroup>)}
              </Select>
            </Field>
            <Field label="Value"><NumInput disabled={ro} value={d.value ?? null} onChange={(v) => setD({ ...d, value: v })} /></Field>
            <Field label="± unc."><NumInput disabled={ro} value={d.uncertainty?.value ?? null} onChange={(v) => setD({ ...d, uncertainty: { type: 'sd', value: v } })} /></Field>
            <Field label="Unit"><Input disabled={ro} className="w-full" value={d.unit ?? ''} onChange={(e) => setD({ ...d, unit: e.target.value })} /></Field>
          </div>
          <div>
            <div className="mb-0.5 flex items-center justify-between text-[11px] font-medium text-neutral-500">Conditions (as stated in the source)
              {!ro && <select className="h-5 rounded border border-neutral-300 text-[10.5px] dark:border-neutral-700 dark:bg-neutral-950" value="" onChange={(e) => e.target.value && setD({ ...d, conditions: { ...d.conditions, [e.target.value]: null } })}><option value="">+ add</option>{catalog.conditions.filter((x) => !(x.key in (d.conditions ?? {}))).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(d.conditions ?? {}).map(([k, v]) => (
                <span key={k} className="flex items-center gap-1 rounded border border-neutral-300 px-1 dark:border-neutral-700">{condLabels[k]?.label ?? k}
                  <input disabled={ro} type="number" className="h-5 w-16 bg-transparent text-right" value={v ?? ''} onChange={(e) => setD({ ...d, conditions: { ...d.conditions, [k]: e.target.value === '' ? null : Number(e.target.value) } })} />{unitLabel(condLabels[k]?.unit)}
                  {!ro && <button onClick={() => { const x = { ...d.conditions }; delete x[k]; setD({ ...d, conditions: x }) }}><X className="h-3 w-3" /></button>}</span>
              ))}
              {!Object.keys(d.conditions ?? {}).length && <span className="text-amber-600">none found in the sentence</span>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Evidence type"><Select disabled={ro} value={d.evidence_type} onChange={(e) => setD({ ...d, evidence_type: e.target.value })}>{Object.entries(catalog.evidence_types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Method"><Input disabled={ro} className="w-full" value={d.method ?? ''} onChange={(e) => setD({ ...d, method: e.target.value })} /></Field>
          </div>
          {c.normalized && <div className="text-[11px] text-neutral-500">Normalised: {c.normalized.ok ? `${fmtSci(c.normalized.value, 4)} ${unitLabel(c.normalized.unit)}` : c.normalized.note}</div>}
        </>
      ) : (
        <>
          <Field label="Equation (LaTeX — correct Greek letters, subscripts and exponents)">
            {ro ? <Equation latex={d.equation?.latex ?? ''} display /> : <EquationEditor value={d.equation?.latex ?? ''} onChange={(v) => setD({ ...d, equation: { ...d.equation!, latex: v } })} />}
          </Field>
          <div className="text-[11px] text-neutral-500">Raw PDF text: <code>{c.equation?.raw}</code></div>
          {c.equation?.template ? <div className="text-[11px]">Machine-readable form: <code className="rounded bg-neutral-100 px-1 dark:bg-white/10">{c.equation.dependent?.symbol} = {c.equation.expression}</code> (template {c.equation.template})</div>
            : <Alert kind="warn">Not a known form. After approval, define the machine-readable expression in the Model Registry; until then it cannot be used for calculation.</Alert>}
          {!!c.equation?.parameters?.length && (
            <table className="w-full text-[11px]"><thead><tr className="text-left text-neutral-500"><th>Parameter</th><th className="text-right">Value from text</th><th className="pl-2">Source</th></tr></thead>
              <tbody>{c.equation.parameters.map((p) => <tr key={p.symbol} className="border-t border-neutral-100 dark:border-white/5"><td><Equation latex={p.latex ?? p.symbol} /> {p.name}</td><td className="num text-right">{p.value !== null ? `${fmtSci(p.value, 4)} ${p.value_unit ?? ''}` : '—'}</td><td className="truncate pl-2 text-neutral-500">{p.source_text ?? (c.equation?.parameter_sets?.length ? 'table rows below' : 'not found')}</td></tr>)}</tbody></table>
          )}
          {!!c.equation?.parameter_sets?.length && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium text-neutral-500">Fitted parameter sets — one model per selected condition set</div>
              {c.equation.parameter_sets.map((s, i) => (
                <label key={i} className="flex items-center gap-2 border-t border-neutral-100 py-0.5 text-[11px] dark:border-white/5">
                  <input type="checkbox" disabled={ro} checked={sets.includes(i)} onChange={(e) => setSets(e.target.checked ? [...sets, i] : sets.filter((x) => x !== i))} />
                  <span className="w-40">{condText(s.conditions, condLabels)}</span>
                  <span className="num flex-1">{Object.entries(s.parameters).map(([k, v]) => `${k.replace('_', ' ')} ${v.value}`).join(' · ')}</span>
                  {s.r2 !== undefined && <span className="text-neutral-500">R² {s.r2}</span>}
                </label>
              ))}
            </div>
          )}
          {c.equation?.validity && Object.keys(c.equation.validity).length > 0 && <div className="text-[11px]">Validity range stated: {Object.entries(c.equation.validity).map(([k, r]) => `${k} ∈ [${r[0]}, ${r[1]}]`).join('; ')}</div>}
        </>
      )}

      {c.status === 'pending' ? (
        <>
          <MaterialPicker c={c} mats={mats} libs={libs} value={mat} onChange={setMat} />
          <div className="flex flex-wrap items-center gap-1">
            {dirty && <Button size="sm" onClick={() => onSave(d)}>Save corrections</Button>}
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}><X className="h-3.5 w-3.5" />Reject</Button>
            <Button size="sm" onClick={() => approve('reviewed')} disabled={!mat.material_id && !mat.new_material?.name}><Check className="h-3.5 w-3.5" />Mark reviewed</Button>
            <Button size="sm" variant="primary" onClick={() => approve('approved')} disabled={!mat.material_id && !mat.new_material?.name}><CheckCheck className="h-3.5 w-3.5" />Approve for calculation</Button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-[11px]">
          {c.approved_as?.map((x) => <Badge key={x.id} tone="green">{x.type} {x.id}</Badge>)}
          {c.status === 'rejected' && <Button size="sm" onClick={() => onAct('reopen')}><RotateCcw className="h-3.5 w-3.5" />Re-open</Button>}
        </div>
      )}
      <Modal open={rejecting} onClose={() => setRejecting(false)} title="Reject candidate" footer={<><Button onClick={() => setRejecting(false)}>Cancel</Button><Button variant="danger" onClick={() => { setRejecting(false); onAct('reject', { reason }) }}>Reject</Button></>}>
        <Field label="Reason (kept for traceability)"><Input autoFocus className="w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. value refers to a different sample" /></Field>
      </Modal>
    </div>
  )
}
