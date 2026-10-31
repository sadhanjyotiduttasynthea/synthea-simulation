import { Beaker, Download, FlaskConical, Pencil, Plus, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import { Alert, Badge, Button, Field, Input, Modal, NumInput, PageHeader, Panel, Prov, Select, Spinner, Stat, Tabs, cx, inputCls } from '../components/ui'
import { api, download, readFile } from '../lib/api'
import { eur, fmt } from '../lib/format'
import type { Experiment } from '../lib/types'
import { useActiveFormulation, useResults, useStore } from '../store'

type Tab = 'records' | 'planning' | 'cost'
const RESPONSES = [['viscosity_pa_s', 'Apparent viscosity [Pa·s]'], ['shape_retention_pct', 'Shape retention [%]'], ['hardness_n', 'Hardness [N]']]

interface Rec {
  phase: string; method: string; reason: string; candidates_evaluated: number; warnings?: string[]
  model?: { kernel: string; n_training: number; data_types: string[] }
  cv?: { q2: number; rmse_transformed: number; space: string; predictions: number[]; observed: number[] }
  recommendations: { rank: number; composition: Record<string, number>; names: Record<string, string>; predicted?: number; band_low?: number; band_high?: number; acquisition?: number }[]
}

export default function Experiments() {
  const { project, setAssistant } = useStore()
  const [tab, setTab] = useState<Tab>('records')
  const [exps, setExps] = useState<Experiment[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    if (!project) return
    setLoading(true)
    setExps(await api.get<Experiment[]>(`/api/experiments?project_id=${project.id}`))
    setLoading(false)
  }, [project])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    setAssistant('experiments', { n_experiments: exps.length, data_types: [...new Set(exps.map((e) => e.data_type))] })
  }, [exps, setAssistant])

  return (
    <div className="space-y-3">
      <PageHeader title="Experiments" subtitle="Record physical experiments, plan the most informative next trials (DoE → Gaussian-process active learning) and quantify the experimental cost scenario." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'records', label: `Experiment records (${exps.length})` }, { id: 'planning', label: 'Experimental design & active learning' }, { id: 'cost', label: 'Cost-reduction calculator' }]} />
      {tab === 'records' && <Records exps={exps} reload={load} loading={loading} />}
      {tab === 'planning' && <Planning exps={exps} reload={load} />}
      {tab === 'cost' && <CostCalc />}
    </div>
  )
}

const blankExp = (pid: string, comp: Record<string, number>): Experiment => ({
  id: '', project_id: pid, name: '', date: new Date().toISOString().slice(0, 10), data_type: 'measured', composition: comp,
  process: { temperature_c: 25, mixing_speed_rpm: null, mixing_time_min: null },
  measurements: { viscosity_pa_s: null, viscosity_shear_rate_1_s: null, hardness_n: null, extrusion_behaviour: null, shape_retention_pct: null }, cost_eur: null, notes: '',
})

function Records({ exps, reload, loading }: { exps: Experiment[]; reload: () => Promise<void>; loading: boolean }) {
  const { project, ingredients, toast } = useStore()
  const active = useActiveFormulation()
  const [edit, setEdit] = useState<Experiment | null>(null)
  const ids = useMemo(() => [...new Set([...Object.keys(project!.optimizer.bounds), ...exps.flatMap((e) => Object.keys(e.composition))])], [exps, project])
  const name = (id: string) => ingredients.find((i) => i.id === id)?.name ?? id
  const nSyn = exps.filter((e) => e.data_type === 'synthetic_demo').length

  const save = async () => {
    if (!edit) return
    const sum = Object.values(edit.composition).reduce((s, v) => s + (v || 0), 0)
    if (Math.abs(sum - 100) > 0.05) return toast(`Composition sums to ${fmt(sum, 2)} % (must be 100 %)`, 'error')
    try {
      if (edit.id) await api.put(`/api/experiments/${edit.id}`, edit)
      else await api.post('/api/experiments', { ...edit, name: edit.name || `EXP-${exps.length + 1}` })
      setEdit(null)
      await reload()
      toast('Experiment saved', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const synth = async () => {
    await api.post('/api/experiments/synthetic', { project_id: project!.id, n: 12, seed: Date.now() % 1000 })
    await reload()
    toast('Added 12 SYNTHETIC demo records (not measurements)', 'success')
  }
  const importCsv = async () => {
    try {
      const csv = await readFile('.csv')
      const r = await api.post<{ imported: number }>('/api/experiments/import-csv', { project_id: project!.id, csv })
      await reload()
      toast(`Imported ${r.imported} experiment(s)`, 'success')
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error')
    }
  }
  const exportCsv = async () => download(`experiments_${project!.id}.csv`, await api.get<string>(`/api/experiments/export-csv?project_id=${project!.id}`), 'text/csv')
  const removeSynthetic = async () => {
    if (!confirm(`Delete all ${nSyn} synthetic demo records?`)) return
    await Promise.all(exps.filter((e) => e.data_type === 'synthetic_demo').map((e) => api.del(`/api/experiments/${e.id}`)))
    await reload()
  }

  return (
    <Panel
      title="Experiment records"
      actions={<>
        <Button size="sm" onClick={() => setEdit(blankExp(project!.id, Object.fromEntries((active?.lines ?? []).map((l) => [l.ingredient_id, l.percent]))))}><Plus className="h-3.5 w-3.5" />Record experiment</Button>
        <Button size="sm" onClick={importCsv}><Upload className="h-3.5 w-3.5" />Import CSV</Button>
        <Button size="sm" onClick={exportCsv} disabled={!exps.length}><Download className="h-3.5 w-3.5" />Export CSV</Button>
        <Button size="sm" variant="ghost" onClick={synth} title="Generate clearly-labelled synthetic records to demonstrate the workflow"><Wand2 className="h-3.5 w-3.5" />Add synthetic demo data</Button>
        {nSyn > 0 && <Button size="sm" variant="danger" onClick={removeSynthetic}>Remove synthetic</Button>}
      </>}
      bodyClass="p-0"
    >
      {nSyn > 0 && <div className="p-2"><Alert kind="warn" title={`${nSyn} SYNTHETIC records present`}>Synthetic demo records are generated by an arbitrary function to exercise the modelling workflow. They are not measurements and any model trained on them has no physical meaning.</Alert></div>}
      {loading ? <div className="p-3"><Spinner label="Loading…" /></div> : exps.length === 0 ? (
        <p className="p-6 text-center text-xs text-neutral-500">No experiments recorded. Record a measured experiment, import a CSV, or use the planning tab to design the first experiments.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="bg-neutral-50 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="px-2 py-1.5 text-left">Name</th><th className="text-left">Type</th><th>Date</th>
                {ids.map((i) => <th key={i} className="px-1 text-right" title={name(i)}>{name(i).split(' ')[0]} %</th>)}
                <th className="px-1 text-right">T °C</th><th className="px-1 text-right">η Pa·s</th><th className="px-1 text-right">Hard. N</th><th className="px-1 text-left">Extrusion</th><th className="px-1 text-right">Shape %</th><th className="px-1 text-right">Cost €</th><th></th>
              </tr>
            </thead>
            <tbody>
              {exps.map((e) => (
                <tr key={e.id} className="border-t border-neutral-100 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/40">
                  <td className="px-2 py-1 font-medium">{e.name}</td>
                  <td><Prov kind={e.data_type === 'planned' ? 'calculated' : e.data_type} />{e.data_type === 'planned' && <span className="ml-1 text-[10px] text-neutral-500">planned</span>}</td>
                  <td className="px-1 text-neutral-500">{e.date ?? '—'}</td>
                  {ids.map((i) => <td key={i} className="num px-1 text-right">{fmt(e.composition[i] ?? 0, 2)}</td>)}
                  <td className="num px-1 text-right">{fmt(e.process.temperature_c as number, 0)}</td>
                  <td className="num px-1 text-right">{fmt(e.measurements.viscosity_pa_s as number, 2)}</td>
                  <td className="num px-1 text-right">{fmt(e.measurements.hardness_n as number, 1)}</td>
                  <td className="px-1">{(e.measurements.extrusion_behaviour as string) ?? '—'}</td>
                  <td className="num px-1 text-right">{fmt(e.measurements.shape_retention_pct as number, 1)}</td>
                  <td className="num px-1 text-right">{fmt(e.cost_eur, 0)}</td>
                  <td className="px-1">
                    <button onClick={() => setEdit(structuredClone(e))} className="p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-white" title="Edit"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={async () => { if (confirm(`Delete ${e.name}?`)) { await api.del(`/api/experiments/${e.id}`); reload() } }} className="p-1 text-neutral-500 hover:text-accent" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'Record experiment'} wide footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        {edit && (
          <div className="grid gap-4 @@5xl:grid-cols-2">
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="EXP-01" /></Field>
                <Field label="Date"><Input type="date" value={edit.date ?? ''} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
                <Field label="Data type" className="col-span-2">
                  <Select value={edit.data_type} onChange={(e) => setEdit({ ...edit, data_type: e.target.value })}>
                    <option value="measured">measured (physical experiment)</option><option value="planned">planned (not yet run)</option><option value="literature">literature</option><option value="synthetic_demo">synthetic demo</option>
                  </Select>
                </Field>
              </div>
              <div className="text-[11px] font-semibold uppercase text-neutral-500">Formulation [% w/w]</div>
              {ids.map((i) => (
                <div key={i} className="grid grid-cols-[1fr_100px] items-center gap-2 text-xs"><span>{name(i)}</span>
                  <NumInput value={edit.composition[i] ?? 0} allowNull={false} onChange={(v) => setEdit({ ...edit, composition: { ...edit.composition, [i]: v ?? 0 } })} /></div>
              ))}
              <div className="text-right text-xs">Σ = <b className="num">{fmt(Object.values(edit.composition).reduce((s, v) => s + (v || 0), 0), 2)} %</b></div>
            </div>
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase text-neutral-500">Processing conditions</div>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Temperature °C"><NumInput value={edit.process.temperature_c} onChange={(v) => setEdit({ ...edit, process: { ...edit.process, temperature_c: v } })} /></Field>
                <Field label="Mixing rpm"><NumInput value={edit.process.mixing_speed_rpm} onChange={(v) => setEdit({ ...edit, process: { ...edit.process, mixing_speed_rpm: v } })} /></Field>
                <Field label="Mixing min"><NumInput value={edit.process.mixing_time_min} onChange={(v) => setEdit({ ...edit, process: { ...edit.process, mixing_time_min: v } })} /></Field>
              </div>
              <div className="text-[11px] font-semibold uppercase text-neutral-500">Measurements</div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Apparent viscosity [Pa·s]"><NumInput value={edit.measurements.viscosity_pa_s as number | null} onChange={(v) => setEdit({ ...edit, measurements: { ...edit.measurements, viscosity_pa_s: v } })} /></Field>
                <Field label="at shear rate [1/s]"><NumInput value={edit.measurements.viscosity_shear_rate_1_s as number | null} onChange={(v) => setEdit({ ...edit, measurements: { ...edit.measurements, viscosity_shear_rate_1_s: v } })} /></Field>
                <Field label="Texture: hardness [N]"><NumInput value={edit.measurements.hardness_n as number | null} onChange={(v) => setEdit({ ...edit, measurements: { ...edit.measurements, hardness_n: v } })} /></Field>
                <Field label="Shape retention [%]"><NumInput value={edit.measurements.shape_retention_pct as number | null} onChange={(v) => setEdit({ ...edit, measurements: { ...edit.measurements, shape_retention_pct: v } })} /></Field>
                <Field label="Extrusion behaviour" className="col-span-2">
                  <Select value={(edit.measurements.extrusion_behaviour as string) ?? ''} onChange={(e) => setEdit({ ...edit, measurements: { ...edit.measurements, extrusion_behaviour: e.target.value || null } })}>
                    <option value="">not recorded</option><option>continuous</option><option>intermittent</option><option>too fluid</option><option>blocked / intermittent</option><option>phase separation</option>
                  </Select>
                </Field>
                <Field label="Experiment cost [€]"><NumInput value={edit.cost_eur} onChange={(v) => setEdit({ ...edit, cost_eur: v })} /></Field>
              </div>
              <Field label="Notes"><textarea className={cx(inputCls, 'h-16 w-full py-1')} value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
            </div>
          </div>
        )}
      </Modal>
    </Panel>
  )
}

function Planning({ exps, reload }: { exps: Experiment[]; reload: () => Promise<void> }) {
  const { project, toast, setResult, setAssistant } = useStore()
  const results = useResults()
  const [response, setResponse] = useState('viscosity_pa_s')
  const [k, setK] = useState(6)
  const [strategy, setStrategy] = useState('uncertainty')
  const [target, setTarget] = useState<number | null>(100)
  const [rec, setRec] = useState<Rec | null>((results.recommendation as Rec) ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const nResp = exps.filter((e) => e.measurements[response] !== null && e.measurements[response] !== undefined).length
  useEffect(() => {
    setAssistant('experiments', { recommendation: rec ? { ...rec, cv: rec.cv ? { q2: rec.cv.q2 } : undefined } : null })
  }, [rec, setAssistant])

  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.post<Rec>('/api/experiments/recommend', { project_id: project!.id, response, k, strategy, target: strategy === 'expected_improvement' ? target : null })
      setRec(r)
      setResult('recommendation', r)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const addPlanned = async () => {
    if (!rec) return
    await Promise.all(rec.recommendations.map((r, i) => api.post('/api/experiments', { ...blankExp(project!.id, r.composition), name: `PLAN-${String(exps.length + i + 1).padStart(2, '0')}`, data_type: 'planned', date: null, notes: `Recommended by ${rec.phase.replace(/_/g, ' ')}${r.predicted !== undefined ? `; predicted ${fmt(r.predicted, 2)}` : ''}` })))
    await reload()
    toast(`${rec.recommendations.length} planned experiments added to records`, 'success')
  }
  const ids = rec ? Object.keys(rec.recommendations[0]?.composition ?? {}) : []
  const parity = rec?.cv ? rec.cv.observed.map((o, i) => ({ observed: o, predicted: rec.cv!.predictions[i] })) : []
  const lim = parity.length ? [Math.min(...parity.flatMap((p) => [p.observed, p.predicted])), Math.max(...parity.flatMap((p) => [p.observed, p.predicted]))] : [0, 1]

  return (
    <div className="grid gap-3 @5xl:grid-cols-[280px_minmax(0,1fr)]">
      <div className="space-y-3">
        <Panel title="Planning settings">
          <div className="space-y-2">
            <Field label="Response to model"><Select value={response} onChange={(e) => setResponse(e.target.value)}>{RESPONSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Experiments to recommend"><NumInput value={k} allowNull={false} onChange={(v) => setK(Math.max(1, Math.min(20, Math.round(v ?? 6))))} /></Field>
            <Field label="Acquisition (active-learning phase)">
              <Select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                <option value="uncertainty">Max uncertainty (improve model)</option>
                <option value="expected_improvement">Approach target value</option>
              </Select>
            </Field>
            {strategy === 'expected_improvement' && <Field label="Target value"><NumInput value={target} onChange={setTarget} /></Field>}
            <div className="rounded border border-neutral-200 p-2 text-[11px] dark:border-neutral-700">Experiments with this response: <b>{nResp}</b>. {nResp < 6 ? 'Phase: design of experiments (space-filling), since ≥ 6 are needed for a surrogate.' : 'Phase: active learning with a Gaussian-process surrogate.'}</div>
            <Button variant="primary" className="w-full" onClick={run} loading={busy}><Sparkles className="h-3.5 w-3.5" />Recommend experiments</Button>
          </div>
        </Panel>
        <Panel title="Experimental region">
          <p className="text-[11px] text-neutral-500">Uses the ingredient bounds defined in the AI Optimizer. The candidate pool is a scrambled Sobol sequence over the bounded mixture simplex.</p>
        </Panel>
      </div>
      <div className="space-y-3">
        {err && <Alert kind="error">{err}</Alert>}
        {busy && <Panel><Spinner label="Generating candidates and fitting model…" /></Panel>}
        {!rec && !busy && <Panel><p className="py-6 text-center text-xs text-neutral-500">Press <b>Recommend experiments</b>. With no data, a space-filling design is proposed; with ≥ 6 measured responses the platform switches to Gaussian-process active learning.</p></Panel>}
        {rec && (
          <>
            <Panel title={rec.phase === 'active_learning' ? 'Active learning recommendations' : 'Design of experiments recommendations'} actions={<Button size="sm" onClick={addPlanned}><FlaskConical className="h-3.5 w-3.5" />Add as planned experiments</Button>}>
              <div className="mb-2 space-y-1 text-xs">
                <div><b>Method:</b> {rec.method}</div>
                <div><b>Reason:</b> {rec.reason} ({rec.candidates_evaluated} feasible candidates evaluated)</div>
                {(rec.warnings ?? []).map((w, i) => <Alert key={i} kind="warn">{w}</Alert>)}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-xs">
                  <thead><tr className="border-b border-neutral-300 text-[10px] uppercase text-neutral-500 dark:border-neutral-700"><th className="py-1 text-left">#</th>{ids.map((i) => <th key={i} className="px-1 text-right">{rec.recommendations[0].names[i]?.split(' ')[0]} %</th>)}{rec.phase === 'active_learning' && <><th className="px-1 text-right">Predicted</th><th className="px-1 text-right">1σ band</th></>}</tr></thead>
                  <tbody>
                    {rec.recommendations.map((r) => (
                      <tr key={r.rank} className="border-b border-neutral-100 dark:border-neutral-800">
                        <td className="py-1">{r.rank}</td>
                        {ids.map((i) => <td key={i} className="num px-1 text-right">{fmt(r.composition[i], 2)}</td>)}
                        {rec.phase === 'active_learning' && <><td className="num px-1 text-right">{fmt(r.predicted, 2)}</td><td className="num px-1 text-right text-neutral-500">{fmt(r.band_low, 2)}–{fmt(r.band_high, 2)}</td></>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            {rec.cv && (
              <div className="grid gap-3 @3xl:grid-cols-2">
                <Panel title={`Surrogate validation (leave-one-out${rec.cv.space === 'log' ? ', log axes' : ''})`} actions={<>{rec.model?.data_types.map((d) => <Prov key={d} kind={d} />)}</>}>
                  <div className="h-56">
                    <ResponsiveContainer>
                      <ScatterChart margin={{ left: 0, right: 10, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="2 4" />
                        <XAxis type="number" dataKey="observed" name="Observed" domain={lim} scale={rec.cv.space === 'log' ? 'log' : 'auto'} tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v, 0)} label={{ value: 'Observed', position: 'insideBottom', offset: -4, fontSize: 10 }} />
                        <YAxis type="number" dataKey="predicted" name="LOO predicted" domain={lim} scale={rec.cv.space === 'log' ? 'log' : 'auto'} tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v, 0)} />
                        <ZAxis range={[30, 30]} />
                        <Tooltip formatter={(v) => fmt(Number(v), 2)} />
                        <ReferenceLine segment={[{ x: lim[0], y: lim[0] }, { x: lim[1], y: lim[1] }]} stroke="#a3a3a3" strokeDasharray="4 3" />
                        <Scatter data={parity} fill="#b91c1c" isAnimationActive={false} />
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
                <Panel title="Model diagnostics">
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="LOO Q²" value={fmt(rec.cv.q2, 2)} sub="1 = perfect, ≤0 = no skill" />
                    <Stat label={`RMSE (${rec.cv.space})`} value={fmt(rec.cv.rmse_transformed, 3)} />
                    <Stat label="Training points" value={rec.model?.n_training ?? '—'} />
                    <Stat label="Candidates" value={rec.candidates_evaluated} />
                  </div>
                  <p className="mt-2 break-all text-[10px] text-neutral-500">Kernel: {rec.model?.kernel}</p>
                  <p className="mt-1 text-[10px] text-neutral-500">Predictions are only as reliable as the validation shows. Validate every recommended formulation experimentally before relying on the model.</p>
                </Panel>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const DEFAULT_SCENARIO = { conventional_experiments: 200, planned_experiments: 60, cost_per_experiment: 170, material_per_experiment_kg: 2, software_modelling_cost: 4000, days_per_experiment: 0.5, material_cost_per_kg: 1.45 }

function CostCalc() {
  const { setResult, setAssistant } = useStore()
  const results = useResults()
  const [p, setP] = useState<typeof DEFAULT_SCENARIO>((results.scenarioInputs as typeof DEFAULT_SCENARIO) ?? DEFAULT_SCENARIO)
  const [r, setR] = useState<Record<string, number | null | string | { planned_experiments: number; net_savings: number }[]> | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      api.post<typeof r>('/api/experiments/cost-scenario', p).then((res) => {
        setR(res)
        setResult('scenario', res)
        setResult('scenarioInputs', p)
      })
    }, 150)
    return () => clearTimeout(t)
  }, [p])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setAssistant('experiments', { cost_scenario: r ? { ...r, sensitivity: undefined } : null })
  }, [r, setAssistant])
  const n = (k: string) => (r?.[k] as number | null) ?? null
  const fields: [keyof typeof DEFAULT_SCENARIO, string][] = [
    ['conventional_experiments', 'Conventional experiments [–]'], ['planned_experiments', 'AI-assisted planned experiments [–]'], ['cost_per_experiment', 'Cost per experiment [€]'],
    ['material_per_experiment_kg', 'Material per experiment [kg]'], ['software_modelling_cost', 'Software & modelling cost [€]'], ['days_per_experiment', 'Lab time per experiment [days]'], ['material_cost_per_kg', 'Material value [€/kg] (info)'],
  ]
  return (
    <div className="grid gap-3 @5xl:grid-cols-[300px_minmax(0,1fr)]">
      <Panel title="Scenario inputs" actions={<Prov kind="illustrative" />}>
        <div className="space-y-2">
          {fields.map(([k, l]) => <Field key={k} label={l}><NumInput value={p[k]} allowNull={false} onChange={(v) => setP({ ...p, [k]: v ?? 0 })} /></Field>)}
          <Button size="sm" variant="ghost" onClick={() => setP(DEFAULT_SCENARIO)}>Reset to default scenario</Button>
          <Alert kind="warn">All inputs are illustrative assumptions. The planned-experiment count is a scenario, not a guaranteed outcome of the platform.</Alert>
        </div>
      </Panel>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 @@5xl:grid-cols-4">
          <Stat label="Conventional cost" value={eur(n('conventional_cost'), 0)} />
          <Stat label="Planned cost" value={eur(n('planned_cost'), 0)} />
          <Stat label="Gross avoided" value={eur(n('gross_avoided'), 0)} />
          <Stat label="Net savings" value={eur(n('net_savings'), 0)} tone="red" sub={`after €${fmt(p.software_modelling_cost, 0)} software/modelling`} />
          <Stat label="Experiment reduction" value={fmt(n('experiment_reduction_pct'), 0)} unit="%" />
          <Stat label="Material saved" value={fmt(n('material_saved_kg'), 0)} unit="kg" sub={`${fmt(n('conventional_material_kg'), 0)} → ${fmt(n('planned_material_kg'), 0)} kg`} />
          <Stat label="Lab time" value={`${fmt(n('conventional_days'), 0)} → ${fmt(n('planned_days'), 0)}`} unit="days" />
          <Stat label="Break-even" value={fmt(n('break_even_experiments_avoided'), 1)} unit="exp. avoided" sub="to recover software cost" />
        </div>
        <div className="grid gap-3 @3xl:grid-cols-2">
          <Panel title="Conventional vs planned">
            <div className="h-56">
              <ResponsiveContainer>
                <BarChart data={[{ name: 'Experiment cost [€]', Conventional: n('conventional_cost'), Planned: (n('planned_cost') ?? 0) + p.software_modelling_cost }, { name: 'Material [kg × 100]', Conventional: (n('conventional_material_kg') ?? 0) * 100, Planned: (n('planned_material_kg') ?? 0) * 100 }]}>
                  <CartesianGrid strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => fmt(Number(v), 0)} /><Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="Conventional" fill="#525252" isAnimationActive={false} />
                  <Bar dataKey="Planned" fill="#b91c1c" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[10px] text-neutral-500">Planned cost bar includes software & modelling cost.</p>
          </Panel>
          <Panel title="Net savings vs number of planned experiments">
            <div className="h-56">
              <ResponsiveContainer>
                <LineChart data={(r?.sensitivity as { planned_experiments: number; net_savings: number }[]) ?? []}>
                  <CartesianGrid strokeDasharray="2 4" />
                  <XAxis dataKey="planned_experiments" type="number" domain={[0, 'dataMax']} tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v, 0)} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v / 1000, 0) + 'k'} />
                  <Tooltip formatter={(v) => eur(Number(v), 0)} labelFormatter={(v) => `${fmt(Number(v), 0)} planned experiments`} />
                  <ReferenceLine y={0} stroke="#737373" />
                  <ReferenceLine x={p.planned_experiments} stroke="#b91c1c" strokeDasharray="4 3" />
                  <Line dataKey="net_savings" stroke="#b91c1c" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>
        <Panel title="Calculation">
          <div className="grid gap-1 font-mono text-[11px] text-neutral-600 dark:text-neutral-400">
            <div>conventional cost = {p.conventional_experiments} × €{p.cost_per_experiment} = {eur(n('conventional_cost'), 0)}</div>
            <div>planned cost = {p.planned_experiments} × €{p.cost_per_experiment} = {eur(n('planned_cost'), 0)}</div>
            <div>net savings = conventional − planned − software ({eur(p.software_modelling_cost, 0)}) = {eur(n('net_savings'), 0)}</div>
            <div>material saved = ({p.conventional_experiments} − {p.planned_experiments}) × {p.material_per_experiment_kg} kg = {fmt(n('material_saved_kg'), 0)} kg (value ≈ {eur(n('material_value_saved'), 0)}, assumed included in cost per experiment)</div>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500"><Beaker className="h-3.5 w-3.5" />{r?.label as string}<Badge tone="amber">illustrative</Badge></div>
        </Panel>
      </div>
    </div>
  )
}
