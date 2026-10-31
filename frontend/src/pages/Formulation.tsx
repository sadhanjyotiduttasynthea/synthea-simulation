import { Copy, GitCompare, Lock, Plus, Save, Scale, Search, Star, Trash2, Unlock, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Alert, Button, Field, Input, KV, Modal, NumInput, PageHeader, Panel, Prov, Spinner, Stat, cx, inputCls } from '../components/ui'
import { api } from '../lib/api'
import { NUTRIENT_LABELS, SERIES, eur, fmt } from '../lib/format'
import { addLine, normalise, removeLine, setPercent, total } from '../lib/formulation'
import { useEvaluation } from '../lib/hooks'
import type { CompositionResult, Formulation as F, Rheology } from '../lib/types'
import { useActiveFormulation, useIngredientMap, useStore } from '../store'

const emptyRheo: Rheology = { yield_stress_pa: null, consistency_index_pa_sn: null, flow_behaviour_index: null, temperature_c: 25, source: '', data_type: 'measured' }

export default function Formulation() {
  const { project, formulations, ingredients, saveFormulation, setActiveFormulation, refreshFormulations, toast, setAssistant } = useStore()
  const ingMap = useIngredientMap()
  const active = useActiveFormulation()
  const [selId, setSelId] = useState<string | undefined>(active?.id)
  const saved = formulations.find((f) => f.id === selId) ?? formulations[0]
  const [draft, setDraft] = useState<F | null>(saved ? structuredClone(saved) : null)
  const [msg, setMsg] = useState<string | undefined>()
  const [q, setQ] = useState('')
  const [temp, setTemp] = useState(25)
  const [saving, setSaving] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const serving = project?.settings.serving_size_g ?? 30
  const { result, loading, error } = useEvaluation(draft?.lines, serving, temp)

  useEffect(() => {
    if (saved && saved.id !== draft?.id) setDraft(structuredClone(saved))
  }, [saved?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setAssistant('formulation', { result, formulation: draft?.name })
  }, [result, draft?.name, setAssistant])

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved)
  const sum = draft ? total(draft.lines) : 0

  const update = (lines: F['lines'], message?: string) => {
    setDraft((d) => (d ? { ...d, lines } : d))
    setMsg(message)
  }

  const persist = async (asNew = false) => {
    if (!draft || !project) return
    if (Math.abs(sum - 100) > 0.01) {
      toast(`Total is ${fmt(sum, 3)} % — must equal 100 % before saving.`, 'error')
      return
    }
    setSaving(true)
    try {
      const doc = asNew ? { ...draft, id: '', name: `${draft.name} (copy)`, origin: 'duplicate' } : draft
      const s = await saveFormulation({ ...doc, project_id: project.id })
      setSelId(s.id)
      setDraft(structuredClone(s))
      toast(asNew ? 'Formulation duplicated' : 'Formulation saved', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const newFormulation = async () => {
    if (!project) return
    const s = await saveFormulation({ id: '', project_id: project.id, name: 'New formulation', origin: 'manual', lines: [], notes: '' })
    setSelId(s.id)
    setDraft(structuredClone(s))
  }

  const del = async () => {
    if (!draft || !confirm(`Delete formulation "${draft.name}"?`)) return
    await api.del(`/api/formulations/${draft.id}`)
    await refreshFormulations()
    setSelId(undefined)
    setDraft(null)
    toast('Formulation deleted', 'success')
  }

  const libFiltered = ingredients.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()))
  const pieData = useMemo(() => (draft?.lines ?? []).filter((l) => l.percent > 0).map((l) => ({ name: ingMap[l.ingredient_id]?.name ?? l.ingredient_id, value: l.percent })), [draft, ingMap])
  const nutData = result ? ['protein', 'carbohydrate', 'fat', 'moisture', 'fibre', 'ash'].map((k) => ({ name: NUTRIENT_LABELS[k], value: result.composition[k] })) : []
  const costData = (result?.cost_breakdown ?? []).map((c) => ({ name: c.ingredient, value: c.contribution ?? 0 }))

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Formulation Studio"
        subtitle="Virtual formulation laboratory: exact mass-balance nutrition and raw-material cost. Totals are constrained to 100 %."
        actions={
          <>
            <Button size="sm" onClick={newFormulation}><Plus className="h-3.5 w-3.5" />New</Button>
            <Button size="sm" disabled={!draft} onClick={() => persist(true)}><Copy className="h-3.5 w-3.5" />Duplicate</Button>
            <Button size="sm" onClick={() => setCompareOpen(true)} disabled={formulations.length < 1}><GitCompare className="h-3.5 w-3.5" />Compare</Button>
            <Button size="sm" disabled={!draft || draft.id === project?.active_formulation_id} onClick={() => draft && setActiveFormulation(draft.id).then(() => toast('Active formulation set — used by optimiser baseline, process and printing', 'success'))}><Star className="h-3.5 w-3.5" />Set active</Button>
            <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={() => persist(false)}><Save className="h-3.5 w-3.5" />Save</Button>
          </>
        }
      />
      <div className="grid gap-3 @5xl:min-h-0 @5xl:flex-1 @5xl:grid-cols-[230px_minmax(0,1fr)_320px]">
        {/* LEFT */}
        <div className="flex flex-col gap-3 @5xl:min-h-0">
          <Panel title="Formulations" bodyClass="p-1 max-h-56 overflow-auto">
            {formulations.map((f) => (
              <button key={f.id} onClick={() => { setSelId(f.id); setDraft(structuredClone(f)) }} className={cx('flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs', f.id === draft?.id ? 'bg-neutral-900 text-white dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800')}>
                <span className="flex-1 truncate">{f.name}</span>
                {f.id === project?.active_formulation_id && <Star className="h-3 w-3 fill-current text-accent" />}
              </button>
            ))}
          </Panel>
          <Panel title="Ingredient library" bodyClass="p-0 flex min-h-0 flex-1 flex-col" className="flex min-h-0 flex-1 flex-col">
            <div className="relative border-b border-neutral-200 p-2 dark:border-neutral-800">
              <Search className="absolute left-4 top-3.5 h-3.5 w-3.5 text-neutral-400" />
              <input className={cx(inputCls, 'w-full pl-7')} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {libFiltered.map((i) => {
                const inF = draft?.lines.some((l) => l.ingredient_id === i.id)
                return (
                  <div key={i.id} className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{i.name}</div>
                      <div className="text-[10px] text-neutral-500">{i.category} · P {fmt(i.nutrition.protein, 1)} % · €{fmt(i.economics.price_per_kg, 2)}/kg</div>
                    </div>
                    <button disabled={!draft || inF || !i.available} title={!i.available ? 'Unavailable' : 'Add to formulation'} onClick={() => { const r = addLine(draft!.lines, i.id, draft!.lines.length ? 5 : 100); update(r.lines, r.message) }} className="rounded border border-neutral-300 p-0.5 disabled:opacity-30 dark:border-neutral-700"><Plus className="h-3 w-3" /></button>
                  </div>
                )
              })}
            </div>
          </Panel>
        </div>

        {/* CENTER */}
        <div className="@container space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          {!draft ? <Panel><p className="text-xs text-neutral-500">Create or select a formulation.</p></Panel> : (
            <>
              <Panel
                title="Composition"
                actions={<>
                  <span className={cx('num mr-2 rounded px-2 py-0.5 text-xs font-semibold', Math.abs(sum - 100) < 0.01 ? 'bg-neutral-100 dark:bg-neutral-800' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300')}>Σ {fmt(sum, 3)} %</span>
                  <Button size="sm" variant="ghost" onClick={() => { const r = normalise(draft.lines); update(r.lines, r.message) }}><Scale className="h-3.5 w-3.5" />Normalise to 100 %</Button>
                  {draft.id && <Button size="sm" variant="ghost" onClick={del}><Trash2 className="h-3.5 w-3.5" /></Button>}
                </>}
              >
                <div className="mb-2 grid grid-cols-[1fr_200px] gap-2">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Formulation name" />
                  <div className="truncate text-right text-[11px] text-neutral-500">origin: {draft.origin ?? 'manual'}</div>
                </div>
                {draft.lines.length === 0 && <p className="py-4 text-center text-xs text-neutral-500">Add ingredients from the library (left).</p>}
                <table className="w-full text-xs">
                  <tbody>
                    {draft.lines.map((l, idx) => {
                      const ing = ingMap[l.ingredient_id]
                      return (
                        <tr key={l.ingredient_id} className="border-b border-neutral-100 dark:border-neutral-800">
                          <td className="w-40 py-1.5 pr-2">
                            <div className="truncate font-medium">{ing?.name ?? l.ingredient_id}</div>
                            <div className="flex gap-1"><Prov kind={ing?.provenance?.nutrition} /></div>
                          </td>
                          <td className="px-2"><input type="range" min={0} max={100} step={0.1} value={l.percent} disabled={l.locked} onChange={(e) => { const r = setPercent(draft.lines, idx, Number(e.target.value)); update(r.lines, r.message) }} className="w-full" aria-label={`${ing?.name} percentage`} /></td>
                          <td className="w-24"><NumInput value={l.percent} allowNull={false} onChange={(v) => { const r = setPercent(draft.lines, idx, v ?? 0); update(r.lines, r.message) }} disabled={l.locked} /></td>
                          <td className="w-6 pl-1 text-neutral-500">%</td>
                          <td className="w-8 text-center">
                            <button title={l.locked ? 'Unlock' : 'Lock concentration'} onClick={() => update(draft.lines.map((x, i) => (i === idx ? { ...x, locked: !x.locked } : x)))} className={l.locked ? 'text-accent' : 'text-neutral-400'}>
                              {l.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                            </button>
                          </td>
                          <td className="w-6 text-center"><button title="Remove" onClick={() => { const r = removeLine(draft.lines, idx); update(r.lines, r.message) }} className="text-neutral-400 hover:text-accent"><X className="h-3.5 w-3.5" /></button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {msg && <div className="mt-2"><Alert kind="warn">{msg}</Alert></div>}
                <p className="mt-2 text-[10px] text-neutral-400">Editing one ingredient rebalances the unlocked ingredients proportionally so the total stays at 100 %. Locked ingredients are never changed.</p>
              </Panel>
              <div className="grid gap-3 @3xl:grid-cols-2">
                <Panel title="Ingredient composition (mass %)">
                  <div className="h-56">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={1} isAnimationActive={false}>
                          {pieData.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                        </Pie>
                        <Tooltip formatter={(v) => `${fmt(Number(v), 2)} %`} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
                <Panel title="Proximate composition (g/100 g)" subtitle="Calculated by mass balance">
                  <div className="h-56">
                    <ResponsiveContainer>
                      <BarChart data={nutData} layout="vertical" margin={{ left: 20 }}>
                        <CartesianGrid strokeDasharray="2 4" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 10 }} domain={[0, 'auto']} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={80} />
                        <Tooltip formatter={(v) => `${fmt(Number(v), 2)} g/100 g`} />
                        <Bar dataKey="value" fill="#262626" isAnimationActive={false}>
                          {nutData.map((d, i) => <Cell key={i} fill={d.name === 'Protein' ? '#b91c1c' : '#525252'} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
                <Panel title="Cost breakdown (€/kg contribution)" className="@3xl:col-span-2">
                  <div className="h-48">
                    <ResponsiveContainer>
                      <BarChart data={costData}>
                        <CartesianGrid strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v) => `€${fmt(Number(v), 4)}/kg`} />
                        <Bar dataKey="value" fill="#b91c1c" isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
              </div>
            </>
          )}
        </div>

        {/* RIGHT */}
        <div className="space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          <Panel title="Results" actions={loading ? <Spinner label="" /> : <Prov kind="calculated" />}>
            {error && <Alert kind="error">{error}</Alert>}
            {result && <ResultsBlock r={result} serving={serving} />}
          </Panel>
          {result?.thermal && (
            <Panel title="Thermophysical properties" actions={<Prov kind="predicted" />}>
              <Field label="Temperature [°C]" className="mb-2"><NumInput value={temp} allowNull={false} onChange={(v) => setTemp(v ?? 25)} min={0} max={150} /></Field>
              <KV rows={[
                ['Density', `${fmt(result.thermal.density_kg_m3, 0)} kg/m³`],
                ['Specific heat', `${fmt(result.thermal.specific_heat_kj_kgk, 3)} kJ/(kg·K)`],
                ['Thermal conductivity', `${fmt(result.thermal.conductivity_w_mk, 3)} W/(m·K)`],
                ['Thermal diffusivity', `${(result.thermal.thermal_diffusivity_m2_s * 1e7).toFixed(3)}×10⁻⁷ m²/s`],
              ]} />
              <p className="mt-1 text-[10px] text-neutral-500">Choi &amp; Okos (1986) composition model; assumes no air inclusion. {result.thermal.warnings.join(' ')}</p>
            </Panel>
          )}
          {result && (
            <Panel title="Predictive models">
              <div className="space-y-1.5">
                {Object.entries(result.predictive_models ?? {}).map(([k, v]) => <Alert key={k} kind="warn" title={`${k[0].toUpperCase()}${k.slice(1)}: not predicted`}>{v}</Alert>)}
              </div>
            </Panel>
          )}
          {draft && <RheologyPanel f={draft} onChange={(rh) => setDraft({ ...draft, rheology: rh })} />}
        </div>
      </div>
      <CompareModal open={compareOpen} onClose={() => setCompareOpen(false)} serving={serving} />
    </div>
  )
}

function ResultsBlock({ r, serving }: { r: CompositionResult; serving: number }) {
  const c = r.composition
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        <Stat label="Protein" value={fmt(c.protein)} unit="%" tone="red" />
        <Stat label="Cost" value={eur(r.cost_per_kg, 3)} unit="/kg" />
        <Stat label="Cost / serving" value={eur(r.cost_per_serving, 4)} sub={`${serving} g`} />
        <Stat label="Cost / g protein" value={r.cost_per_g_protein !== null ? `€${(r.cost_per_g_protein * 100).toFixed(3)}` : '—'} unit="/100 g P" />
      </div>
      <KV rows={[
        ['Fat', `${fmt(c.fat)} %`], ['Carbohydrate', `${fmt(c.carbohydrate)} %`], ['Moisture', `${fmt(c.moisture)} %`], ['Fibre', `${fmt(c.fibre)} %`],
        ['Ash', `${fmt(c.ash)} %`], ['Sodium', `${fmt(c.sodium, 3)} g/100 g`], ['Salt equivalent', `${fmt(r.salt_equivalent_g_100g, 2)} g/100 g`],
        ['Energy', `${fmt(r.energy_kcal_100g, 0)} kcal · ${fmt(r.energy_kj_100g, 0)} kJ /100 g`],
      ]} />
      {r.warnings.map((w, i) => <Alert key={i} kind="error">{w}</Alert>)}
      {r.missing_data.length > 0 && <Alert kind="warn" title="Missing data">{r.missing_data.join('; ')}</Alert>}
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-neutral-500">Input data provenance: {r.provenance?.map((p) => <Prov key={p} kind={p} />)}</div>
    </div>
  )
}

function RheologyPanel({ f, onChange }: { f: F; onChange: (r: Rheology | null) => void }) {
  const r = f.rheology ?? null
  const set = (k: keyof Rheology, v: unknown) => onChange({ ...(r ?? emptyRheo), [k]: v })
  return (
    <Panel title="Formulation rheology (Herschel–Bulkley)" actions={r ? <Prov kind={r.data_type} /> : <Prov kind="missing" />}>
      <p className="mb-2 text-[11px] text-neutral-500">Enter flow-curve parameters measured for <i>this formulation</i>. They enable pipe, die and nozzle pressure calculations. Leave empty if not measured.</p>
      <div className="grid grid-cols-3 gap-2">
        <Field label="τ₀ [Pa]"><NumInput value={r?.yield_stress_pa} onChange={(v) => set('yield_stress_pa', v)} /></Field>
        <Field label="K [Pa·sⁿ]"><NumInput value={r?.consistency_index_pa_sn} onChange={(v) => set('consistency_index_pa_sn', v)} /></Field>
        <Field label="n [–]"><NumInput value={r?.flow_behaviour_index} onChange={(v) => set('flow_behaviour_index', v)} /></Field>
        <Field label="T [°C]"><NumInput value={r?.temperature_c} onChange={(v) => set('temperature_c', v)} /></Field>
        <Field label="Data type" className="col-span-2">
          <select className={cx(inputCls, 'w-full')} value={r?.data_type ?? 'measured'} onChange={(e) => set('data_type', e.target.value)}>
            <option value="measured">measured</option><option value="literature">literature</option><option value="illustrative">illustrative</option>
          </select>
        </Field>
        <Field label="Source / method" className="col-span-3"><Input value={r?.source ?? ''} onChange={(e) => set('source', e.target.value)} placeholder="e.g. rotational rheometer, 25 °C, 0.1–100 1/s" /></Field>
      </div>
      {r && <button className="mt-2 text-[11px] text-accent underline" onClick={() => onChange(null)}>Clear rheology</button>}
      <p className="mt-1 text-[10px] text-neutral-400">Save the formulation to persist.</p>
    </Panel>
  )
}

function CompareModal({ open, onClose, serving }: { open: boolean; onClose: () => void; serving: number }) {
  const { formulations } = useStore()
  const [sel, setSel] = useState<string[]>([])
  const [res, setRes] = useState<Record<string, CompositionResult>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setSel(formulations.slice(0, 4).map((f) => f.id))
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || sel.length === 0) return
    setBusy(true)
    Promise.all(sel.map((id) => api.post<CompositionResult>('/api/formulations/evaluate', { lines: formulations.find((f) => f.id === id)!.lines, serving_size_g: serving }).then((r) => [id, r] as const)))
      .then((pairs) => setRes(Object.fromEntries(pairs)))
      .finally(() => setBusy(false))
  }, [open, sel.join(','), serving])  // eslint-disable-line react-hooks/exhaustive-deps
  const rows: [string, (r: CompositionResult) => string][] = [
    ['Protein %', (r) => fmt(r.composition.protein)], ['Fat %', (r) => fmt(r.composition.fat)], ['Carbohydrate %', (r) => fmt(r.composition.carbohydrate)],
    ['Moisture %', (r) => fmt(r.composition.moisture)], ['Sodium g/100 g', (r) => fmt(r.composition.sodium, 3)], ['Energy kcal/100 g', (r) => fmt(r.energy_kcal_100g, 0)],
    ['Cost €/kg', (r) => fmt(r.cost_per_kg, 3)], ['Cost €/serving', (r) => fmt(r.cost_per_serving, 4)], ['Cost €/100 g protein', (r) => (r.cost_per_g_protein ? fmt(r.cost_per_g_protein * 100, 3) : '—')],
  ]
  return (
    <Modal open={open} onClose={onClose} title="Compare formulations" wide>
      <div className="mb-3 flex flex-wrap gap-2">
        {formulations.map((f) => (
          <label key={f.id} className="flex items-center gap-1 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-700">
            <input type="checkbox" checked={sel.includes(f.id)} onChange={(e) => setSel(e.target.checked ? [...sel, f.id] : sel.filter((x) => x !== f.id))} />{f.name}
          </label>
        ))}
      </div>
      {busy && <Spinner />}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-neutral-300 text-left dark:border-neutral-700"><th className="py-1">Property</th>{sel.map((id) => <th key={id} className="text-right">{formulations.find((f) => f.id === id)?.name}</th>)}</tr></thead>
          <tbody>
            {rows.map(([label, fn]) => (
              <tr key={label} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-1 text-neutral-500">{label}</td>
                {sel.map((id) => <td key={id} className="num text-right">{res[id] ? fn(res[id]) : '…'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
