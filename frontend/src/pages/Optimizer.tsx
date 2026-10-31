import { Factory, Play, Printer, Save, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts'
import { Alert, Badge, Button, Field, NumInput, PageHeader, Panel, Prov, Select, Spinner, cx } from '../components/ui'
import { api } from '../lib/api'
import { SERIES, eur, fmt } from '../lib/format'
import type { Candidate, Formulation, OptimizationResult, OptimizerSettings } from '../lib/types'
import { useActiveFormulation, useResults, useStore } from '../store'

const NUTRIENTS: [string, string][] = [['fat', 'Fat %'], ['carbohydrate', 'Carbohydrate %'], ['moisture', 'Moisture %'], ['fibre', 'Fibre %'], ['sodium', 'Sodium g/100 g']]
const MODES = [
  ['all', 'Compare 3 candidates (cost / balanced / protein)'],
  ['lowest_cost', 'A · Lowest cost'],
  ['highest_protein', 'B · Highest protein'],
  ['processing', 'C · Best processing compatibility'],
] as const
const RESPONSES = [['viscosity_pa_s', 'Apparent viscosity [Pa·s]'], ['shape_retention_pct', 'Shape retention [%]'], ['hardness_n', 'Hardness [N]']]

export default function Optimizer() {
  const { project, ingredients, saveProject, saveFormulation, setActiveFormulation, toast, setAssistant, setResult } = useStore()
  const results = useResults()
  const active = useActiveFormulation()
  const nav = useNavigate()
  const [opt, setOpt] = useState<OptimizerSettings>(() => structuredClone(project!.optimizer))
  const [mode, setMode] = useState<string>('all')
  const [uncC, setUncC] = useState(5)
  const [uncP, setUncP] = useState(10)
  const [proc, setProc] = useState<{ response: string; lower: number | null; upper: number | null }>(project?.optimizer.processing ?? { response: 'viscosity_pa_s', lower: 50, upper: 200 })
  const [res, setRes] = useState<OptimizationResult | null>((results.optimization as OptimizationResult) ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState(0)

  useEffect(() => {
    setOpt(structuredClone(project!.optimizer))
  }, [project?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setAssistant('optimizer', { optimisation: res ? { ...res, pareto: undefined } : null })
  }, [res, setAssistant])

  const included = opt.ingredient_ids ?? Object.keys(opt.bounds)
  const allergens = useMemo(() => [...new Set(ingredients.flatMap((i) => i.allergens))], [ingredients])
  const ingName = (id: string) => ingredients.find((i) => i.id === id)?.name ?? id

  const toggleIng = (id: string, on: boolean) => {
    const ids = on ? [...included, id] : included.filter((x) => x !== id)
    const bounds = { ...opt.bounds }
    if (on && !bounds[id]) bounds[id] = [0, 100]
    setOpt({ ...opt, ingredient_ids: ids, bounds })
  }
  const setBound = (id: string, k: 0 | 1, v: number | null) => {
    const b = [...(opt.bounds[id] ?? [0, 100])] as [number | null, number | null]
    b[k] = v
    setOpt({ ...opt, bounds: { ...opt.bounds, [id]: b } })
  }
  const setLimit = (n: string, k: 0 | 1, v: number | null) => {
    const b = [...(opt.nutrient_limits[n] ?? [null, null])] as [number | null, number | null]
    b[k] = v
    setOpt({ ...opt, nutrient_limits: { ...opt.nutrient_limits, [n]: b } })
  }

  const run = async () => {
    setBusy(true)
    setErr(null)
    const req = {
      ...opt,
      ingredient_ids: included,
      mode,
      processing: mode === 'processing' || mode === 'all' ? (mode === 'processing' ? proc : null) : null,
      baseline: Object.fromEntries((active?.lines ?? []).map((l) => [l.ingredient_id, l.percent])),
      serving_size_g: project!.settings.serving_size_g,
      composition_uncertainty_rel: uncC / 100,
      price_uncertainty_rel: uncP / 100,
      project_id: project!.id,
    }
    try {
      const r = await api.post<OptimizationResult>('/api/optimize', req)
      setRes(r)
      setSel(0)
      setResult('optimization', r)
      setResult('optimizationRequest', req)
      toast(r.status === 'optimal' ? `Optimisation complete: ${r.candidates.length} candidate(s)` : 'Problem is infeasible — see diagnosis', r.status === 'optimal' ? 'success' : 'error')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveConstraints = async () => {
    await saveProject({ ...project!, optimizer: { ...opt, ingredient_ids: included, processing: proc } })
    toast('Constraints saved to project', 'success')
  }

  const saveCandidate = async (c: Candidate, then?: string) => {
    if (!c.formulation) return
    const f: Formulation = {
      id: '', project_id: project!.id, name: `${c.label} — ${fmt(c.composition?.protein, 1)} % protein`, origin: `optimizer:${c.mode}`,
      lines: c.formulation.filter((l) => l.percent > 1e-6).map((l) => ({ ingredient_id: l.ingredient_id, percent: Math.round(l.percent * 1e6) / 1e6, locked: false })),
      notes: c.rationale,
    }
    const s = await saveFormulation(f)
    if (then) {
      await setActiveFormulation(s.id)
      nav(then)
    } else toast(`Saved as formulation "${s.name}"`, 'success')
  }

  const cands = res?.candidates ?? []
  const cur = cands[sel]
  const base = res?.baseline

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="AI Optimizer"
        subtitle="Constrained formulation optimisation: exact linear programming (HiGHS) for cost/nutrition, ε-constraint Pareto front, Gaussian-process surrogate for processing targets."
        actions={<>
          <Button size="sm" onClick={saveConstraints}><Save className="h-3.5 w-3.5" />Save constraints</Button>
          <Button variant="primary" onClick={run} loading={busy}><Play className="h-3.5 w-3.5" />Run optimiser</Button>
        </>}
      />
      <div className="grid gap-3 @5xl:min-h-0 @5xl:flex-1 @5xl:grid-cols-[300px_minmax(0,1fr)_330px]">
        {/* LEFT: constraints */}
        <div className="space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          <Panel title="Objective">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          </Panel>
          <Panel title="Primary constraints">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min protein [%]"><NumInput value={opt.min_protein} onChange={(v) => setOpt({ ...opt, min_protein: v })} /></Field>
              <Field label="Max cost [€/kg]"><NumInput value={opt.max_cost} onChange={(v) => setOpt({ ...opt, max_cost: v })} /></Field>
            </div>
          </Panel>
          <Panel title="Nutrient limits" bodyClass="p-2">
            <table className="w-full text-xs">
              <thead><tr className="text-[10px] text-neutral-500"><th className="text-left">Nutrient</th><th>Min</th><th>Max</th></tr></thead>
              <tbody>
                {NUTRIENTS.map(([k, l]) => (
                  <tr key={k}><td className="pr-1 text-neutral-600 dark:text-neutral-400">{l}</td>
                    <td className="p-0.5"><NumInput value={opt.nutrient_limits[k]?.[0] ?? null} onChange={(v) => setLimit(k, 0, v)} placeholder="–" /></td>
                    <td className="p-0.5"><NumInput value={opt.nutrient_limits[k]?.[1] ?? null} onChange={(v) => setLimit(k, 1, v)} placeholder="–" /></td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Ingredients & bounds [% w/w]" bodyClass="p-2">
            <table className="w-full text-xs">
              <thead><tr className="text-[10px] text-neutral-500"><th></th><th className="text-left">Ingredient</th><th>Min</th><th>Max</th></tr></thead>
              <tbody>
                {ingredients.map((i) => {
                  const on = included.includes(i.id)
                  return (
                    <tr key={i.id} className={cx(!on && 'opacity-50')}>
                      <td><input type="checkbox" checked={on} disabled={!i.available} onChange={(e) => toggleIng(i.id, e.target.checked)} title={i.available ? 'Include' : 'Marked unavailable in library'} /></td>
                      <td className="truncate pr-1" title={i.name}>{i.name}</td>
                      <td className="w-16 p-0.5"><NumInput value={opt.bounds[i.id]?.[0] ?? 0} onChange={(v) => setBound(i.id, 0, v)} disabled={!on} /></td>
                      <td className="w-16 p-0.5"><NumInput value={opt.bounds[i.id]?.[1] ?? 100} onChange={(v) => setBound(i.id, 1, v)} disabled={!on} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Panel>
          <Panel title="Allergen restrictions">
            {allergens.length === 0 ? <p className="text-xs text-neutral-500">No allergen tags in library.</p> : allergens.map((a) => (
              <label key={a} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={(opt.excluded_allergens ?? []).includes(a)} onChange={(e) => setOpt({ ...opt, excluded_allergens: e.target.checked ? [...(opt.excluded_allergens ?? []), a] : (opt.excluded_allergens ?? []).filter((x) => x !== a) })} />
                Exclude ingredients tagged “{a}”
              </label>
            ))}
          </Panel>
          <Panel title="Processing target (mode C)">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Response" className="col-span-2"><Select value={proc.response} onChange={(e) => setProc({ ...proc, response: e.target.value })}>{RESPONSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label="Lower"><NumInput value={proc.lower} onChange={(v) => setProc({ ...proc, lower: v })} /></Field>
              <Field label="Upper"><NumInput value={proc.upper} onChange={(v) => setProc({ ...proc, upper: v })} /></Field>
            </div>
            <p className="mt-1 text-[10px] text-neutral-500">Requires ≥ 6 experiments with this response recorded in Experiments. A GP surrogate is trained on them.</p>
          </Panel>
          <Panel title="Uncertainty assumptions (illustrative)">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Protein content ± [% rel]"><NumInput value={uncC} allowNull={false} onChange={(v) => setUncC(v ?? 5)} /></Field>
              <Field label="Price ± [% rel]"><NumInput value={uncP} allowNull={false} onChange={(v) => setUncP(v ?? 10)} /></Field>
            </div>
          </Panel>
        </div>

        {/* CENTER */}
        <div className="@container space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          {err && <Alert kind="error" title="Optimisation failed">{err}</Alert>}
          {busy && <Panel><Spinner label="Solving linear programmes and Pareto front…" /></Panel>}
          {!res && !busy && <Panel><p className="py-8 text-center text-sm text-neutral-500">Set constraints and press <b>Run optimiser</b>. Demo: min protein 15 %, max cost €2.20/kg.</p></Panel>}
          {res?.status === 'infeasible' && <Infeasible res={res} />}
          {res && cands.length > 0 && (
            <>
              <div className={cx('grid gap-2', cands.length >= 3 ? '@xl:grid-cols-3' : cands.length === 2 ? '@xl:grid-cols-2' : '')}>
                {cands.map((c, i) => (
                  <button key={i} onClick={() => setSel(i)} className={cx('rounded border bg-white p-3 text-left dark:bg-neutral-900', i === sel ? 'border-accent ring-1 ring-accent' : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800')}>
                    <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide">{c.label}</span>
                      {c.status && c.status !== 'optimal' ? <Badge tone="amber">{c.status.replace('_', ' ')}</Badge> : c.all_satisfied ? <Badge tone="green">feasible</Badge> : <Badge tone="red">violations</Badge>}
                    </div>
                    {c.composition ? (
                      <>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div><div className="text-[10px] uppercase text-neutral-500">Protein</div><div className="num text-xl font-semibold text-accent">{fmt(c.composition.protein)}<span className="text-xs text-neutral-500"> %</span></div></div>
                          <div><div className="text-[10px] uppercase text-neutral-500">Cost</div><div className="num text-xl font-semibold">{eur(c.cost_per_kg, 3)}<span className="text-xs text-neutral-500">/kg</span></div></div>
                        </div>
                        <div className="mt-1 text-[11px] text-neutral-500">{eur(c.cost_per_serving, 4)}/serving · fat {fmt(c.composition.fat, 1)} % · moisture {fmt(c.composition.moisture, 1)} %</div>
                        <CompBar c={c} />
                        {base?.composition && <div className="mt-1 text-[11px]">vs baseline: protein <b className="num">{signed(c.composition.protein - base.composition.protein)} pp</b>, cost <b className="num">{signed((c.cost_per_kg ?? 0) - (base.cost_per_kg ?? 0), 3)} €/kg</b></div>}
                      </>
                    ) : <p className="mt-2 text-xs text-neutral-500">{c.message}</p>}
                  </button>
                ))}
              </div>
              <div className="grid gap-3 @3xl:grid-cols-2">
                <Panel title="Pareto front: protein vs cost" subtitle="ε-constraint method (minimum cost at each protein level)">
                  <Pareto res={res} />
                </Panel>
                <Panel title="Composition comparison [% w/w]">
                  <CompChart res={res} />
                </Panel>
              </div>
              <Panel title="Candidate comparison table">
                <CompareTable res={res} />
              </Panel>
            </>
          )}
          {res && <p className="text-[10px] text-neutral-500">Method: {res.method}</p>}
        </div>

        {/* RIGHT */}
        <div className="space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          {cur?.formulation && (
            <Panel title={`Selected: ${cur.label}`}>
              <p className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">{cur.rationale}</p>
              <table className="mb-2 w-full text-xs">
                <tbody>{cur.formulation.map((l) => <tr key={l.ingredient_id} className="border-b border-neutral-100 dark:border-neutral-800"><td className="py-0.5">{l.name}</td><td className="num text-right font-medium">{fmt(l.percent, 3)} %</td></tr>)}</tbody>
              </table>
              <div className="grid grid-cols-2 gap-1.5">
                <Button size="sm" onClick={() => saveCandidate(cur)}><Save className="h-3.5 w-3.5" />Save</Button>
                <Button size="sm" onClick={() => saveCandidate(cur, '/formulation')}><Star className="h-3.5 w-3.5" />Open in studio</Button>
                <Button size="sm" onClick={() => saveCandidate(cur, '/process')}><Factory className="h-3.5 w-3.5" />To process</Button>
                <Button size="sm" onClick={() => saveCandidate(cur, '/printing')}><Printer className="h-3.5 w-3.5" />To 3D print</Button>
              </div>
            </Panel>
          )}
          {cur?.prediction && (
            <Panel title="Surrogate prediction" actions={<Prov kind="predicted" />}>
              <div className="text-xs">
                <div>{cur.response_label}: <b className="num">{fmt(cur.prediction.value, 2)} {cur.unit}</b> (1σ band {fmt(cur.prediction.band_low, 2)}–{fmt(cur.prediction.band_high, 2)})</div>
                <div>Target window: {fmt(cur.prediction.target_low, 1)}–{fmt(cur.prediction.target_high, 1)} {cur.unit}</div>
                <div>Distance to nearest experiment: {fmt(cur.prediction.novelty, 2)} (standardised)</div>
                <div>Model: n = {cur.model?.n_training}, LOO Q² = {fmt(cur.cv?.q2, 2)}</div>
                <div className="mt-1 flex gap-1">{cur.model?.data_types.map((d) => <Prov key={d} kind={d} />)}</div>
              </div>
              {(cur.model_warnings ?? []).map((w, i) => <div key={i} className="mt-1.5"><Alert kind="warn">{w}</Alert></div>)}
            </Panel>
          )}
          {cur?.constraints && (
            <Panel title="Constraint satisfaction" bodyClass="p-2">
              <table className="w-full text-xs">
                <thead><tr className="text-[10px] text-neutral-500"><th className="text-left">Constraint</th><th className="text-right">Value</th><th></th></tr></thead>
                <tbody>
                  {cur.constraints.map((k, i) => (
                    <tr key={i} className="border-b border-neutral-100 dark:border-neutral-800">
                      <td className="py-0.5">{k.constraint}</td>
                      <td className="num text-right">{fmt(k.value, 3)}</td>
                      <td className="pl-1 text-right">{!k.satisfied ? <Badge tone="red">violated</Badge> : k.binding ? <Badge tone="amber">binding</Badge> : <span className="text-[10px] text-neutral-400">slack</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          {cur?.sensitivities && cur.sensitivities.length > 0 && (
            <Panel title="Trade-offs (LP sensitivities)" actions={<Prov kind="calculated" />}>
              <ul className="space-y-1 text-xs">{cur.sensitivities.slice(0, 6).map((s, i) => <li key={i}>• {s.text}</li>)}</ul>
            </Panel>
          )}
          {cur?.uncertainty && (
            <Panel title="Uncertainty (Monte Carlo)" actions={<Prov kind="illustrative" />}>
              <div className="space-y-0.5 text-xs">
                <div>Protein 90 % interval: <b className="num">{fmt(cur.uncertainty.protein_p05)}–{fmt(cur.uncertainty.protein_p95)} %</b></div>
                <div>Cost 90 % interval: <b className="num">€{fmt(cur.uncertainty.cost_p05, 3)}–{fmt(cur.uncertainty.cost_p95, 3)}/kg</b></div>
                {cur.uncertainty.p_protein_ok !== undefined && <div>P(protein ≥ min): <b className="num">{fmt(cur.uncertainty.p_protein_ok * 100, 0)} %</b></div>}
                {cur.uncertainty.p_cost_ok !== undefined && <div>P(cost ≤ max): <b className="num">{fmt(cur.uncertainty.p_cost_ok * 100, 0)} %</b></div>}
                <p className="pt-1 text-[10px] text-neutral-500">{cur.uncertainty.assumptions} A candidate on a binding constraint has ≈50 % probability of meeting it under uncertainty; add a safety margin if needed.</p>
              </div>
            </Panel>
          )}
          {res && (
            <Panel title="Limitations">
              <ul className="space-y-1 text-[11px] text-neutral-600 dark:text-neutral-400">{res.limitations.map((l, i) => <li key={i}>• {l}</li>)}</ul>
              {res.excluded.length > 0 && <div className="mt-2 text-[11px]"><b>Excluded:</b> {res.excluded.map((e) => `${e.name} (${e.reason})`).join(', ')}</div>}
            </Panel>
          )}
        </div>
      </div>
    </div>
  )

  function CompBar({ c }: { c: Candidate }) {
    return (
      <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-sm">
        {(c.formulation ?? []).map((l, i) => <div key={l.ingredient_id} title={`${l.name}: ${fmt(l.percent, 2)} %`} style={{ width: `${l.percent}%`, background: SERIES[i % SERIES.length] }} />)}
      </div>
    )
  }

  function CompChart({ res }: { res: OptimizationResult }) {
    const series = [...(res.baseline ? [{ label: 'Baseline', formulation: res.baseline.formulation }] : []), ...res.candidates.filter((c) => c.formulation)]
    const data = res.ingredients.map((ing) => {
      const row: Record<string, string | number> = { name: ingName(ing.id).replace(' (sodium chloride)', '') }
      for (const s of series) row[s.label] = s.formulation?.find((l) => l.ingredient_id === ing.id)?.percent ?? 0
      return row
    })
    return (
      <div className="h-64">
        <ResponsiveContainer>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-25} textAnchor="end" height={48} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip formatter={(v) => `${fmt(Number(v), 2)} %`} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {series.map((s, i) => <Bar key={s.label} dataKey={s.label} fill={s.label === 'Baseline' ? '#d4d4d4' : ['#b91c1c', '#262626', '#737373', '#ef4444'][i % 4]} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  function CompareTable({ res }: { res: OptimizationResult }) {
    const cols = [...(res.baseline ? [res.baseline] : []), ...res.candidates.filter((c) => c.composition)]
    const names = [...(res.baseline ? ['Baseline'] : []), ...res.candidates.filter((c) => c.composition).map((c) => c.label)]
    const rows: [string, (c: Candidate) => string][] = [
      ['Protein %', (c) => fmt(c.composition?.protein)], ['Fat %', (c) => fmt(c.composition?.fat)], ['Carbohydrate %', (c) => fmt(c.composition?.carbohydrate)],
      ['Moisture %', (c) => fmt(c.composition?.moisture)], ['Sodium g/100 g', (c) => fmt(c.composition?.sodium, 3)], ['Energy kcal/100 g', (c) => fmt(c.energy_kcal_100g, 0)],
      ['Cost €/kg', (c) => fmt(c.cost_per_kg, 3)], ['Cost €/serving', (c) => fmt(c.cost_per_serving, 4)], ['Cost €/100 g protein', (c) => (c.cost_per_g_protein ? fmt(c.cost_per_g_protein * 100, 3) : '—')],
      ['All constraints met', (c) => (c.all_satisfied ? 'yes' : 'no')],
    ]
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-neutral-300 dark:border-neutral-700"><th className="py-1 text-left">Property</th>{names.map((n) => <th key={n} className="text-right">{n}</th>)}</tr></thead>
          <tbody>{rows.map(([l, f]) => <tr key={l} className="border-b border-neutral-100 dark:border-neutral-800"><td className="py-0.5 text-neutral-500">{l}</td>{cols.map((c, i) => <td key={i} className="num text-right">{f(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    )
  }
}

const signed = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`

function Pareto({ res }: { res: OptimizationResult }) {
  const front = res.pareto.map((p) => ({ protein: p.protein, frontier: p.cost }))
  const pts = res.candidates.filter((c) => c.composition).map((c) => ({ protein: c.composition!.protein, cand: c.cost_per_kg, label: c.label }))
  const base = res.baseline?.composition ? [{ protein: res.baseline.composition.protein, baseline: res.baseline.cost_per_kg }] : []
  const budget = res.candidates[0]?.constraints?.find((k) => k.kind === 'cost_max')?.limit
  const data = [...front, ...pts, ...base].sort((a, b) => a.protein - b.protein)
  return (
    <div className="h-64">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ left: 0, right: 10 }}>
          <CartesianGrid strokeDasharray="2 4" />
          <XAxis dataKey="protein" type="number" domain={['auto', 'auto']} tick={{ fontSize: 10 }} label={{ value: 'Protein [%]', position: 'insideBottom', offset: -2, fontSize: 10 }} tickFormatter={(v) => fmt(v, 0)} />
          <YAxis tick={{ fontSize: 10 }} label={{ value: '€/kg', angle: -90, position: 'insideLeft', fontSize: 10 }} domain={['auto', 'auto']} tickFormatter={(v) => fmt(v, 2)} />
          <Tooltip formatter={(v) => (typeof v === 'number' ? fmt(v, 3) : v)} labelFormatter={(v) => `Protein ${fmt(Number(v), 2)} %`} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          {budget !== undefined && <ReferenceLine y={budget} stroke="#b91c1c" strokeDasharray="4 3" label={{ value: 'budget', fontSize: 9, fill: '#b91c1c' }} />}
          <Line dataKey="frontier" name="Pareto front (min cost)" stroke="#525252" dot={{ r: 2 }} connectNulls isAnimationActive={false} />
          <Scatter dataKey="cand" name="Candidates" fill="#b91c1c" isAnimationActive={false} />
          <Scatter dataKey="baseline" name="Baseline" fill="#a3a3a3" shape="diamond" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function Infeasible({ res }: { res: OptimizationResult }) {
  const inf = res.infeasibility!
  return (
    <Panel title="Infeasible problem — diagnosis" className="border-red-300 dark:border-red-900">
      <div className="space-y-2 text-xs">
        {inf.reasons.map((r, i) => <Alert key={i} kind="error">{r}</Alert>)}
        {inf.relaxations.length > 0 && (
          <div>
            <div className="mb-1 font-semibold">Minimum relaxation (elastic linear programme)</div>
            <table className="w-full"><thead><tr className="text-[10px] text-neutral-500"><th className="text-left">Constraint</th><th className="text-right">Current</th><th className="text-right">Required</th></tr></thead>
              <tbody>{inf.relaxations.map((r, i) => <tr key={i} className="border-b border-neutral-100 dark:border-neutral-800"><td>{r.constraint}</td><td className="num text-right">{fmt(r.current, 3)}</td><td className="num text-right font-semibold text-accent">{fmt(r.required, 3)}</td></tr>)}</tbody></table>
          </div>
        )}
        <div className="font-semibold">Suggestions</div>
        <ul className="list-disc space-y-1 pl-4">{inf.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
        {res.pareto.length > 0 && <p className="text-neutral-500">The Pareto front (ignoring the budget) is shown below for reference.</p>}
        {res.pareto.length > 0 && <Pareto res={res} />}
      </div>
    </Panel>
  )
}
