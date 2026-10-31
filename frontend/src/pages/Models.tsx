import { Check, CheckCheck, ExternalLink, FlaskConical, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Equation } from '../components/Equation'
import { EquationEditor } from '../components/EquationEditor'
import { Plot } from '../components/Plot'
import { Alert, Badge, Button, Field, Input, Modal, NumInput, PageHeader, Panel, Select, cx, inputCls } from '../components/ui'
import { api } from '../lib/api'
import { fmtSci } from '../lib/format'
import { type Material, STATUS_STYLE, condText, unitLabel } from '../lib/sci'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector, useEquations } from '../workspace/Slots'
import { log } from '../workspace/wsStore'

interface Sym { symbol: string; latex?: string; name: string; unit: string; value?: number | null }
export interface SciModel {
  id: string; name: string; template?: string; category?: string; latex: string; expression: string; status: string
  dependent: Sym; variables: Sym[]; parameters: Sym[]; constants?: Record<string, { value: number; unit: string }>
  material_id?: string; conditions?: Record<string, number>; validity?: Record<string, number[]>; provides?: string[]
  source?: { paper_id?: string; page?: number; snippet?: string; citation?: string; table_ref?: string }
  validation?: { dataset: string; n: number; rmse: number; r2: number; mae: number; mape_pct: number; date: string; points: { observed: number; predicted: number }[] }[]
  limitations?: string[]; dimension_check?: { ok: boolean | null; message: string }; history?: { t: string; note: string; status?: string }[]; version?: number
  fit_quality?: { r2?: number }; evidence_type?: string
}

const STATUSES = ['extracted', 'reviewed', 'approved', 'validated', 'deprecated']

export default function Models() {
  const { toast } = useStore()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [models, setModels] = useState<SciModel[]>([])
  const [mats, setMats] = useState<Material[]>([])
  const [status, setStatus] = useState('')
  const [matF, setMatF] = useState('')
  const [compare, setCompare] = useState<string[]>([])
  const [draft, setDraft] = useState<SciModel | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [templates, setTemplates] = useState<Record<string, SciModel & { name: string }>>({})
  const mid = params.get('model')

  const load = useCallback(() => api.get<SciModel[]>('/api/sci-models').then(setModels), [])
  useEffect(() => { load(); api.get<Material[]>('/api/materials').then(setMats); api.get<typeof templates>('/api/sci-models/templates').then(setTemplates) }, [load])
  const cur = models.find((m) => m.id === mid) ?? null
  useEffect(() => { setDraft(cur ? structuredClone(cur) : null) }, [cur?.id, cur?.version])  // eslint-disable-line react-hooks/exhaustive-deps
  useCommand('model.new', () => setNewOpen(true))
  useEquations(cur ? [{ title: cur.name, latex: cur.latex, status: cur.status, note: `Machine-readable: ${cur.dependent.symbol} = ${cur.expression}` }] : Object.values(templates).map((t) => ({ title: t.name, latex: t.latex, status: 'template' })), [cur?.id, templates])

  const matName = (id?: string) => mats.find((m) => m.id === id)?.name ?? '—'
  const shown = models.filter((m) => (!status || m.status === status) && (!matF || m.material_id === matF))
  const dirty = draft && cur && JSON.stringify(draft) !== JSON.stringify(cur)

  const save = async (patch?: Partial<SciModel>, note?: string) => {
    if (!draft) return
    try {
      const r = await api.put<SciModel>(`/api/sci-models/${draft.id}`, { ...draft, ...patch, _note: note })
      await load()
      refreshTree()
      if (cur?.status !== r.status) log(r.status === 'reviewed' && cur?.status === 'approved' ? 'warn' : 'info', 'registry', `${r.name}: status ${r.status}`)
      toast(`Saved (${r.status})`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const setStat = async (s: string) => {
    if (!cur) return
    try {
      await api.post(`/api/sci-models/${cur.id}/status`, { status: s })
      await load()
      refreshTree()
      log('info', 'registry', `${cur.name} → ${s}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const createFrom = async (tid: string, material_id: string) => {
    try {
      const m = await api.post<SciModel>('/api/sci-models', tid === 'custom'
        ? { name: 'Custom model', category: 'other', latex: 'y = a\\,x + b', expression: 'a * x + b', dependent: { symbol: 'y', name: 'output', unit: '' }, variables: [{ symbol: 'x', name: 'input', unit: '' }], parameters: [{ symbol: 'a', name: 'slope', unit: '', value: null }, { symbol: 'b', name: 'intercept', unit: '', value: null }], material_id, provides: [] }
        : { template: tid, material_id, status: 'extracted', source: { citation: 'Manually entered' } })
      setNewOpen(false)
      await load()
      setParams({ model: m.id })
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Scientific Model Registry" subtitle="Equations with parameters, units, validity ranges and provenance. Only approved models are used by simulations; validated models carry a comparison with experimental data."
        actions={<Button size="sm" variant="primary" onClick={() => setNewOpen(true)}><Plus className="h-3.5 w-3.5" />New model</Button>} />
      <div className="grid min-h-0 flex-1 gap-3 @4xl:grid-cols-[280px_minmax(0,1fr)]">
        <Panel title={`Models (${shown.length})`} bodyClass="p-0" className="flex min-h-0 flex-col">
          <div className="grid grid-cols-2 gap-1 border-b border-neutral-200 p-2 dark:border-white/10">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select>
            <Select value={matF} onChange={(e) => setMatF(e.target.value)}><option value="">All materials</option>{mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {shown.length === 0 && <p className="p-3 text-xs text-neutral-500">No models. Approve equations from a research paper or create one from a template.</p>}
            {shown.map((m) => (
              <div key={m.id} onClick={() => setParams({ model: m.id })} className={cx('mb-0.5 cursor-pointer rounded px-2 py-1.5 text-xs', m.id === mid ? 'bg-neutral-900 text-white dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>
                <div className="flex items-start gap-1.5">
                  <input type="checkbox" title="Overlay in comparison plot" checked={compare.includes(m.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setCompare(e.target.checked ? [...compare, m.id] : compare.filter((x) => x !== m.id))} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 font-medium">{m.name}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] opacity-80"><span className={cx('rounded px-1 font-semibold uppercase', STATUS_STYLE[m.status])}>{m.status}</span>{matName(m.material_id)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <div className="flex min-h-0 flex-col gap-3 @4xl:overflow-y-auto">
          {compare.length > 1 && <ComparePlot models={models.filter((m) => compare.includes(m.id))} />}
          {draft && cur ? (
            <>
              <Panel title={draft.name} subtitle={`${draft.category ?? ''} · ${matName(draft.material_id)} · v${draft.version ?? 1}`}
                actions={<>
                  <span className={cx('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', STATUS_STYLE[cur.status])}>{cur.status}</span>
                  {cur.status === 'extracted' && <Button size="sm" onClick={() => setStat('reviewed')}><Check className="h-3.5 w-3.5" />Mark reviewed</Button>}
                  {['extracted', 'reviewed'].includes(cur.status) && <Button size="sm" variant="primary" onClick={() => setStat('approved')} disabled={cur.dimension_check?.ok === false}><CheckCheck className="h-3.5 w-3.5" />Approve for calculation</Button>}
                  {cur.status === 'approved' && <Button size="sm" onClick={() => setStat('validated')} disabled={!cur.validation?.length} title={cur.validation?.length ? '' : 'Attach a validation result first'}><ShieldCheck className="h-3.5 w-3.5" />Mark validated</Button>}
                  {cur.status !== 'deprecated' && <Button size="sm" variant="ghost" onClick={() => confirm('Deprecate this model? It stays in the registry for traceability but cannot be used.') && setStat('deprecated')}><Trash2 className="h-3.5 w-3.5" /></Button>}
                  {dirty && <Button size="sm" variant="primary" onClick={() => save(undefined, 'edited in registry')}><Save className="h-3.5 w-3.5" />Save</Button>}
                </>}>
                <div className="overflow-x-auto py-2 text-center text-lg"><Equation latex={draft.latex} display /></div>
                <div className="text-center text-[11px] text-neutral-500">Machine-readable: <code className="rounded bg-neutral-100 px-1 dark:bg-white/10">{draft.dependent.symbol} = {draft.expression}</code></div>
                <div className="mt-2 flex flex-wrap justify-center gap-2 text-[11px]">
                  {cur.dimension_check && <span className={cx('rounded px-1.5 py-0.5', cur.dimension_check.ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : cur.dimension_check.ok === false ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300' : 'bg-neutral-100 dark:bg-white/10')}>Dimensional check: {cur.dimension_check.ok ? '✓ ' : cur.dimension_check.ok === false ? '✗ ' : ''}{cur.dimension_check.message}</span>}
                  {draft.conditions && Object.keys(draft.conditions).length > 0 && <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-white/10">Conditions: {condText(draft.conditions)}</span>}
                  {cur.fit_quality?.r2 !== undefined && cur.fit_quality.r2 !== null && <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-white/10">Reported fit R² = {cur.fit_quality.r2}</span>}
                </div>
                {cur.status === 'approved' && dirty && <div className="mt-2"><Alert kind="warn">Saving changes to the equation, parameters or validity of an approved model resets it to <b>reviewed</b>; it must be re-approved before use.</Alert></div>}
              </Panel>

              <div className="grid gap-3 @5xl:grid-cols-2">
                <Panel title="Parameters, variables and validity" bodyClass="p-2">
                  <SymTable title="Parameters" rows={draft.parameters} withValue onChange={(rows) => setDraft({ ...draft, parameters: rows })} />
                  <SymTable title="Independent variables" rows={draft.variables} validity={draft.validity ?? {}} onValidity={(v) => setDraft({ ...draft, validity: v })} onChange={(rows) => setDraft({ ...draft, variables: rows })} />
                  <div className="mt-2 grid grid-cols-3 gap-1.5 text-xs">
                    <Field label="Dependent symbol"><Input className="w-full font-mono" value={draft.dependent.symbol} onChange={(e) => setDraft({ ...draft, dependent: { ...draft.dependent, symbol: e.target.value } })} /></Field>
                    <Field label="Name"><Input className="w-full" value={draft.dependent.name} onChange={(e) => setDraft({ ...draft, dependent: { ...draft.dependent, name: e.target.value } })} /></Field>
                    <Field label="Unit"><Input className="w-full" value={draft.dependent.unit} onChange={(e) => setDraft({ ...draft, dependent: { ...draft.dependent, unit: e.target.value } })} /></Field>
                  </div>
                  {draft.constants && Object.keys(draft.constants).length > 0 && <div className="mt-1 text-[11px] text-neutral-500">Constants: {Object.entries(draft.constants).map(([k, c]) => `${k} = ${c.value} ${unitLabel(c.unit)}`).join(', ')}</div>}
                </Panel>
                <EvaluatePanel m={cur} />
              </div>

              <div className="grid gap-3 @5xl:grid-cols-2">
                <Panel title="Source and provenance">
                  {cur.source?.paper_id ? (
                    <div className="space-y-1 text-xs">
                      <div>{cur.source.citation}</div>
                      <div>Page {cur.source.page}{cur.source.table_ref ? ` · ${cur.source.table_ref}` : ''}</div>
                      {cur.source.snippet && <div className="rounded bg-neutral-100 p-1.5 italic dark:bg-white/5">“{cur.source.snippet}”</div>}
                      <Button size="sm" onClick={() => nav(`/papers?paper=${cur.source!.paper_id}`)}><ExternalLink className="h-3.5 w-3.5" />Open source paper</Button>
                    </div>
                  ) : <p className="text-xs text-neutral-500">{cur.source?.citation ?? 'No source recorded.'}</p>}
                  <div className="mt-2 text-xs"><b>Limitations</b><ul className="list-disc pl-4 text-neutral-600 dark:text-neutral-400">{(cur.limitations ?? []).map((l, i) => <li key={i}>{l}</li>)}</ul></div>
                </Panel>
                <ValidationPanel m={cur} onDone={load} />
              </div>
              <Panel title="Version history">
                <ul className="space-y-0.5 text-[11px]">{(cur.history ?? []).slice().reverse().map((h, i) => <li key={i}><span className="text-neutral-400">{new Date(h.t).toLocaleString()}</span> — {h.note}{h.status ? ` [${h.status}]` : ''}</li>)}</ul>
              </Panel>
            </>
          ) : <Panel><p className="py-8 text-center text-sm text-neutral-500">Select a model. Tick several models to overlay them (e.g. the same constitutive law fitted at different concentrations).</p></Panel>}
        </div>
      </div>

      <Inspector>
        {draft ? (
          <div className="space-y-2 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Model settings</div>
            <Field label="Name"><Input className="w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Material"><Select value={draft.material_id ?? ''} onChange={(e) => setDraft({ ...draft, material_id: e.target.value })}><option value="">—</option>{mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
            <Field label="LaTeX (display form)"><EquationEditor value={draft.latex} onChange={(v) => setDraft({ ...draft, latex: v })} /></Field>
            <Field label="Machine-readable expression (safe parser syntax)"><Input className="w-full font-mono" value={draft.expression} onChange={(e) => setDraft({ ...draft, expression: e.target.value })} /></Field>
            <Field label="Provides quantities (comma separated)" hint="e.g. viscosity, rheology_hb, rate_constant"><Input className="w-full" value={(draft.provides ?? []).join(', ')} onChange={(e) => setDraft({ ...draft, provides: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
            <Field label="Limitations (one per line)"><textarea className={cx(inputCls, 'h-16 w-full py-1')} value={(draft.limitations ?? []).join('\n')} onChange={(e) => setDraft({ ...draft, limitations: e.target.value.split('\n').filter(Boolean) })} /></Field>
            <Button size="sm" variant="primary" disabled={!dirty} onClick={() => save(undefined, 'edited in registry')}><Save className="h-3.5 w-3.5" />Save model</Button>
          </div>
        ) : <p className="p-1 text-xs text-neutral-500">Statuses: extracted → reviewed → approved for calculation → validated (needs comparison with data) → deprecated.</p>}
      </Inspector>

      <NewModelModal open={newOpen} onClose={() => setNewOpen(false)} templates={templates} mats={mats} onCreate={createFrom} />
    </div>
  )
}

function SymTable({ title, rows, onChange, withValue, validity, onValidity }: { title: string; rows: Sym[]; onChange: (r: Sym[]) => void; withValue?: boolean; validity?: Record<string, number[]>; onValidity?: (v: Record<string, number[]>) => void }) {
  const set = (i: number, k: keyof Sym, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center justify-between text-[11px] font-medium text-neutral-500">{title}<button className="text-rose-600" onClick={() => onChange([...rows, { symbol: `p${rows.length + 1}`, name: '', unit: '', value: null }])}>+ add</button></div>
      <table className="w-full text-xs">
        <thead className="text-left text-[10px] text-neutral-500"><tr><th>Symbol</th><th>Name</th><th>Unit</th>{withValue && <th className="text-right">Value</th>}{validity && <th className="text-center">Validated range</th>}<th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-neutral-100 dark:border-white/5">
              <td className="w-20 py-0.5 pr-1"><div className="flex items-center gap-1"><Equation latex={r.latex ?? r.symbol} /><input className="w-full min-w-0 bg-transparent font-mono text-[10px] text-neutral-400" value={r.symbol} onChange={(e) => set(i, 'symbol', e.target.value)} /></div></td>
              <td className="pr-1"><input className="w-full bg-transparent" value={r.name} onChange={(e) => set(i, 'name', e.target.value)} /></td>
              <td className="w-20 pr-1"><input className="w-full bg-transparent font-mono" value={r.unit} onChange={(e) => set(i, 'unit', e.target.value)} /></td>
              {withValue && <td className="w-24"><NumInput value={r.value ?? null} onChange={(v) => set(i, 'value', v)} placeholder="missing" /></td>}
              {validity && onValidity && (
                <td className="w-40">
                  <div className="flex gap-0.5">
                    <NumInput value={validity[r.symbol]?.[0] ?? null} onChange={(v) => { const n = { ...validity }; if (v === null && (validity[r.symbol]?.[1] ?? null) === null) delete n[r.symbol]; else n[r.symbol] = [v ?? 0, validity[r.symbol]?.[1] ?? v ?? 0]; onValidity(n) }} placeholder="min" />
                    <NumInput value={validity[r.symbol]?.[1] ?? null} onChange={(v) => { const n = { ...validity }; n[r.symbol] = [validity[r.symbol]?.[0] ?? 0, v ?? 0]; onValidity(n) }} placeholder="max" />
                  </div>
                </td>
              )}
              <td className="w-5 text-center"><button className="text-neutral-400 hover:text-rose-600" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EvaluatePanel({ m }: { m: SciModel }) {
  const v0 = m.variables[0]
  const rng = m.validity?.[v0?.symbol] ?? null
  const [x, setX] = useState<number>(rng ? (rng[0] + rng[1]) / 2 : 1)
  const [res, setRes] = useState<{ value: number; unit: string; extrapolated: boolean; warnings: string[] } | string | null>(null)
  const [curve, setCurve] = useState<{ x: number; y: number | null; extrapolated: boolean }[]>([])
  const [allow, setAllow] = useState(false)
  const isLog = v0?.symbol === 'gamma_dot'
  const lo = rng ? (isLog ? rng[0] / 3 : rng[0] - 0.25 * (rng[1] - rng[0])) : isLog ? 0.01 : 0
  const hi = rng ? (isLog ? rng[1] * 3 : rng[1] + 0.25 * (rng[1] - rng[0])) : isLog ? 1000 : 100
  useEffect(() => {
    if (!v0) return
    api.post<{ points: typeof curve }>(`/api/sci-models/${m.id}/curve`, { variable: v0.symbol, lo: Math.max(lo, isLog ? 1e-3 : -1e9), hi, log: isLog }).then((r) => setCurve(r.points)).catch(() => setCurve([]))
  }, [m.id, m.version])  // eslint-disable-line react-hooks/exhaustive-deps
  const evaluate = async () => {
    try {
      setRes(await api.post(`/api/sci-models/${m.id}/evaluate`, { inputs: { [v0.symbol]: x }, allow_extrapolation: allow }))
    } catch (e) {
      setRes((e as Error).message)
    }
  }
  if (!v0) return <Panel title="Evaluate"><p className="text-xs text-neutral-500">No independent variable defined.</p></Panel>
  const inR = curve.filter((p) => !p.extrapolated), outR = curve.filter((p) => p.extrapolated)
  return (
    <Panel title="Evaluate model" actions={<Badge tone={['approved', 'validated'].includes(m.status) ? 'green' : 'amber'}>{['approved', 'validated'].includes(m.status) ? 'usable' : 'preview only'}</Badge>}>
      <Plot height={210} data={[
        { type: 'scatter', mode: 'lines', name: 'within validated range', x: inR.map((p) => p.x), y: inR.map((p) => p.y), line: { color: '#e11d48', width: 2.5 } },
        { type: 'scatter', mode: 'markers', name: 'extrapolation (not validated)', x: outR.map((p) => p.x), y: outR.map((p) => p.y), marker: { color: '#a3a3a3', size: 4 } },
      ]} layout={{ xaxis: { title: { text: `${v0.name} [${unitLabel(v0.unit)}]` }, type: isLog ? 'log' : 'linear' }, yaxis: { title: { text: `${m.dependent.name} [${unitLabel(m.dependent.unit)}]` } }, margin: { l: 56, r: 10, t: 10, b: 44 },
        shapes: rng ? [{ type: 'rect', xref: 'x', yref: 'paper', x0: rng[0], x1: rng[1], y0: 0, y1: 1, fillcolor: 'rgba(8,145,178,0.08)', line: { width: 0 } }] : [] }} />
      <div className="mt-1 flex flex-wrap items-end gap-2 text-xs">
        <Field label={`${v0.name} [${unitLabel(v0.unit)}]`}><NumInput value={x} allowNull={false} onChange={(v) => setX(v ?? 0)} className="w-28" /></Field>
        <label className="mb-1 flex items-center gap-1"><input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />allow extrapolation (flagged)</label>
        <Button size="sm" onClick={evaluate}>Evaluate</Button>
      </div>
      {res && (typeof res === 'string' ? <div className="mt-1"><Alert kind="error">{res}</Alert></div> : (
        <div className="mt-1 text-sm">{m.dependent.symbol} = <b className="num">{fmtSci(res.value, 5)}</b> {unitLabel(res.unit)} {res.extrapolated && <Badge tone="red">extrapolated</Badge>}</div>
      ))}
      {rng && <p className="mt-1 text-[10px] text-neutral-500">Shaded: validated range of {v0.name} [{rng[0]}, {rng[1]}] {unitLabel(v0.unit)}. Evaluations outside it are refused unless extrapolation is explicitly allowed.</p>}
    </Panel>
  )
}

function ValidationPanel({ m, onDone }: { m: SciModel; onDone: () => void }) {
  const v0 = m.variables[0]
  const [rows, setRows] = useState('')
  const [label, setLabel] = useState('Laboratory dataset')
  const { toast } = useStore()
  const last = m.validation?.[m.validation.length - 1]
  const run = async () => {
    const data = rows.split(/\n/).map((l) => l.split(/[,;\t ]+/).map(Number)).filter((r) => r.length >= 2 && r.every(Number.isFinite)).map((r) => ({ inputs: { [v0.symbol]: r[0] }, observed: r[1] }))
    if (data.length < 2) return toast('Enter at least two rows: input, observed', 'error')
    try {
      await api.post(`/api/sci-models/${m.id}/validate`, { data, label })
      log('info', 'registry', `Validation of ${m.name} against ${label} attached`)
      onDone()
    } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <Panel title="Validation against experimental data" actions={<FlaskConical className="h-3.5 w-3.5 text-cyan-600" />}>
      {last && (
        <div className="mb-2 grid grid-cols-[1fr_1fr] gap-2">
          <Plot height={160} data={[{ type: 'scatter', mode: 'markers', x: last.points.map((p) => p.observed), y: last.points.map((p) => p.predicted), marker: { color: '#e11d48' }, name: 'points' },
            { type: 'scatter', mode: 'lines', x: [Math.min(...last.points.map((p) => p.observed)), Math.max(...last.points.map((p) => p.observed))], y: [Math.min(...last.points.map((p) => p.observed)), Math.max(...last.points.map((p) => p.observed))], line: { dash: 'dash', color: '#a3a3a3' }, name: 'y = x' }]}
            layout={{ showlegend: false, xaxis: { title: { text: 'observed' } }, yaxis: { title: { text: 'predicted' } }, margin: { l: 44, r: 6, t: 6, b: 36 } }} />
          <div className="text-xs"><div className="font-semibold">{last.dataset}</div><div>n = {last.n}</div><div>RMSE = {fmtSci(last.rmse, 4)} {unitLabel(m.dependent.unit)}</div><div>MAE = {fmtSci(last.mae, 4)}</div><div>R² = {fmtSci(last.r2, 3)}</div><div>MAPE = {fmtSci(last.mape_pct, 3)} %</div><div className="text-neutral-500">{new Date(last.date).toLocaleDateString()}</div></div>
        </div>
      )}
      <Field label={`Paste data: ${v0?.symbol ?? 'x'} [${unitLabel(v0?.unit)}], observed ${m.dependent.symbol} [${unitLabel(m.dependent.unit)}] — one row per line`}>
        <textarea className={cx(inputCls, 'h-16 w-full py-1 font-mono text-[11px]')} value={rows} onChange={(e) => setRows(e.target.value)} placeholder={'10, 130\n50, 190'} />
      </Field>
      <div className="mt-1 flex gap-1"><Input className="flex-1" value={label} onChange={(e) => setLabel(e.target.value)} /><Button size="sm" onClick={run}>Compare & attach</Button></div>
      <p className="mt-1 text-[10px] text-neutral-500">Predictions are compared with observations without refitting. Validation results are required before a model can be marked validated.</p>
    </Panel>
  )
}

function ComparePlot({ models }: { models: SciModel[] }) {
  const [curves, setCurves] = useState<Record<string, { x: number; y: number | null; extrapolated: boolean }[]>>({})
  const v = models[0].variables[0]
  const same = models.every((m) => m.variables[0]?.symbol === v?.symbol && m.dependent.unit === models[0].dependent.unit)
  const viscosity = useMemo(() => same && v?.symbol === 'gamma_dot', [same, v])
  useEffect(() => {
    if (!same || !v) return
    Promise.all(models.map((m) => {
      const r = m.validity?.[v.symbol]
      const lo = r ? r[0] : v.symbol === 'gamma_dot' ? 0.1 : 0, hi = r ? r[1] : v.symbol === 'gamma_dot' ? 100 : 100
      return api.post<{ points: { x: number; y: number | null; extrapolated: boolean }[] }>(`/api/sci-models/${m.id}/curve`, { variable: v.symbol, lo, hi, log: v.symbol === 'gamma_dot' }).then((res) => [m.id, res.points] as const)
    })).then((pairs) => setCurves(Object.fromEntries(pairs)))
  }, [models.map((m) => m.id).join(',')])  // eslint-disable-line react-hooks/exhaustive-deps
  if (!same) return <Alert kind="warn">Selected models have different variables or output units and cannot be overlaid.</Alert>
  return (
    <Panel title={`Coexisting models (${models.length}) — ${viscosity ? 'apparent viscosity (shear stress / shear rate)' : models[0].dependent.name}`} subtitle="Each curve is shown only within its own validated range.">
      <Plot height={290} data={models.map((m) => ({ type: 'scatter' as const, mode: 'lines' as const, name: m.name.split('— ').pop() ?? m.name, x: (curves[m.id] ?? []).map((p) => p.x), y: (curves[m.id] ?? []).map((p) => (viscosity && p.y !== null ? p.y / p.x : p.y)) }))}
        layout={{ xaxis: { title: { text: `${v.name} [${unitLabel(v.unit)}]` }, type: v.symbol === 'gamma_dot' ? 'log' : 'linear' }, yaxis: { title: { text: viscosity ? 'apparent viscosity [Pa·s]' : `${models[0].dependent.name} [${unitLabel(models[0].dependent.unit)}]` }, type: viscosity ? 'log' : 'linear' } }} />
    </Panel>
  )
}

function NewModelModal({ open, onClose, templates, mats, onCreate }: { open: boolean; onClose: () => void; templates: Record<string, { name: string; latex: string }>; mats: Material[]; onCreate: (tid: string, material_id: string) => void }) {
  const [tid, setTid] = useState('herschel_bulkley')
  const [mid, setMid] = useState('')
  return (
    <Modal open={open} onClose={onClose} title="New model" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!mid} onClick={() => onCreate(tid, mid)}>Create</Button></>}>
      <div className="space-y-2 text-xs">
        <Field label="Template"><Select value={tid} onChange={(e) => setTid(e.target.value)}>{Object.entries(templates).map(([k, t]) => <option key={k} value={k}>{t.name}</option>)}<option value="custom">Custom equation</option></Select></Field>
        {templates[tid] && <div className="rounded border border-neutral-200 p-2 text-center dark:border-white/10"><Equation latex={templates[tid].latex} display /></div>}
        <Field label="Material"><Select value={mid} onChange={(e) => setMid(e.target.value)}><option value="">— select —</option>{mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <p className="text-neutral-500">New models start as <b>extracted</b>. Enter parameter values, units, validity ranges and the source, then review and approve.</p>
      </div>
    </Modal>
  )
}
