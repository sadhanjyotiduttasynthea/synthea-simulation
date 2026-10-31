import { CheckCircle2, Circle, FileDown, FileJson, FileSpreadsheet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, PageHeader, Panel, Prov } from '../components/ui'
import { api, download } from '../lib/api'
import { fmt, toCsv } from '../lib/format'
import type { Candidate, CompositionResult, OptimizationResult } from '../lib/types'
import { useActiveFormulation, useIngredientMap, useResults, useStore } from '../store'

type SectionId = 'formulation' | 'optimization' | 'process' | 'print' | 'recommendation' | 'scenario'
interface PdfSection { title: string; paragraphs?: string[]; tables?: { caption?: string; headers: string[]; rows: (string | number | null)[][] }[]; bullets?: string[] }

const SECTIONS: { id: SectionId; title: string; source: string; to: string }[] = [
  { id: 'formulation', title: 'Formulation composition, nutrition & cost', source: 'Active formulation (Formulation Studio)', to: '/formulation' },
  { id: 'optimization', title: 'Optimisation results', source: 'AI Optimizer run', to: '/optimizer' },
  { id: 'process', title: 'Process simulation results', source: 'Process Simulator run', to: '/process' },
  { id: 'print', title: 'Printer parameters & print estimate', source: '3D Printing Lab toolpath', to: '/printing' },
  { id: 'recommendation', title: 'Experimental recommendations', source: 'Experiments → planning', to: '/experiments' },
  { id: 'scenario', title: 'Experimental cost-saving scenario', source: 'Experiments → cost calculator', to: '/experiments' },
]

export default function Reports() {
  const { project, toast, setAssistant } = useStore()
  const results = useResults()
  const active = useActiveFormulation()
  const ingMap = useIngredientMap()
  const [evalRes, setEvalRes] = useState<CompositionResult | null>(null)
  const [sel, setSel] = useState<Record<SectionId, boolean>>({ formulation: true, optimization: true, process: true, print: true, recommendation: true, scenario: true })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (active) api.post<CompositionResult>('/api/formulations/evaluate', { lines: active.lines, serving_size_g: project?.settings.serving_size_g ?? 30 }).then(setEvalRes)
  }, [active, project?.settings.serving_size_g])
  useEffect(() => {
    setAssistant('reports', { result: evalRes })
  }, [evalRes, setAssistant])

  const available: Record<SectionId, boolean> = {
    formulation: !!evalRes, optimization: !!results.optimization, process: !!results.process, print: !!results.print,
    recommendation: !!results.recommendation, scenario: !!results.scenario,
  }

  const build = (): PdfSection[] => {
    const out: PdfSection[] = []
    if (sel.formulation && evalRes && active) {
      const c = evalRes.composition
      out.push({
        title: `Formulation: ${active.name}`,
        paragraphs: ['Composition and nutrition are calculated by linear mass balance from the ingredient library. Ingredient values flagged as illustrative are demonstration placeholders.'],
        tables: [
          { caption: 'Composition', headers: ['Ingredient', 'Mass %', 'Price €/kg', 'Cost contribution €/kg', 'Nutrition data'], rows: active.lines.map((l) => {
            const ing = ingMap[l.ingredient_id]
            const cb = evalRes.cost_breakdown.find((b) => b.ingredient === ing?.name)
            return [ing?.name ?? l.ingredient_id, fmt(l.percent, 3), fmt(ing?.economics.price_per_kg, 3), fmt(cb?.contribution, 4), ing?.provenance?.nutrition ?? 'missing']
          }) },
          { caption: 'Nutrition (calculated, per 100 g)', headers: ['Protein %', 'Fat %', 'Carbohydrate %', 'Moisture %', 'Fibre %', 'Sodium g', 'Energy kcal'], rows: [[fmt(c.protein), fmt(c.fat), fmt(c.carbohydrate), fmt(c.moisture), fmt(c.fibre), fmt(c.sodium, 3), fmt(evalRes.energy_kcal_100g, 0)]] },
          { caption: 'Cost (raw materials, calculated)', headers: ['€/kg', `€/serving (${project?.settings.serving_size_g} g)`, '€/100 g protein'], rows: [[fmt(evalRes.cost_per_kg, 3), fmt(evalRes.cost_per_serving, 4), evalRes.cost_per_g_protein ? fmt(evalRes.cost_per_g_protein * 100, 3) : '—']] },
        ],
        bullets: [...evalRes.missing_data.map((m) => `Missing data: ${m}`), ...Object.entries(evalRes.predictive_models ?? {}).map(([k, v]) => `${k}: ${v}`)],
      })
    }
    const opt = results.optimization as OptimizationResult | undefined
    if (sel.optimization && opt) {
      const req = results.optimizationRequest as { min_protein?: number; max_cost?: number } | undefined
      if (opt.status === 'infeasible') {
        out.push({ title: 'Optimisation results — infeasible', paragraphs: opt.infeasibility?.reasons ?? [], bullets: [...(opt.infeasibility?.relaxations.map((r) => r.text) ?? []), ...(opt.infeasibility?.suggestions ?? [])] })
      } else {
        const cands = opt.candidates.filter((c) => c.formulation)
        out.push({
          title: 'Optimisation results',
          paragraphs: [`Constraints: protein ≥ ${req?.min_protein ?? '—'} %, cost ≤ €${req?.max_cost ?? '—'}/kg plus ingredient bounds and nutrient limits. ${opt.method}`],
          tables: [
            { caption: 'Candidate formulations [% w/w]', headers: ['Ingredient', ...(opt.baseline ? ['Baseline'] : []), ...cands.map((c) => c.label)], rows: opt.ingredients.map((i) => [i.name, ...(opt.baseline ? [fmt(opt.baseline.formulation?.find((l) => l.ingredient_id === i.id)?.percent, 3)] : []), ...cands.map((c) => fmt(c.formulation!.find((l) => l.ingredient_id === i.id)?.percent, 3))]) },
            { caption: 'Key results', headers: ['Candidate', 'Protein %', 'Cost €/kg', '€/serving', 'Constraints met', 'Protein 90 % interval*', 'P(protein ok)*'], rows: [...(opt.baseline ? [opt.baseline] : []), ...cands].map((c: Candidate, k) => [k === 0 && opt.baseline ? 'Baseline' : c.label, fmt(c.composition?.protein), fmt(c.cost_per_kg, 3), fmt(c.cost_per_serving, 4), c.all_satisfied ? 'yes' : 'no', c.uncertainty ? `${fmt(c.uncertainty.protein_p05)}–${fmt(c.uncertainty.protein_p95)}` : '—', c.uncertainty?.p_protein_ok !== undefined ? `${fmt(c.uncertainty.p_protein_ok * 100, 0)} %` : '—']) },
          ],
          bullets: [...cands.flatMap((c) => (c.sensitivities ?? []).slice(0, 2).map((s) => `${c.label}: ${s.text}`)), '* Monte-Carlo with illustrative uncertainty assumptions.', ...opt.limitations],
        })
      }
    }
    const proc = results.process as { summary: Record<string, number | string | null>; units: { label: string; outputs: Record<string, number | null>; unsupported: string[] }[]; formulation?: string; flow?: string; disclaimer: string } | undefined
    if (sel.process && proc) {
      const s = proc.summary
      out.push({
        title: `Process simulation: ${proc.flow ?? ''}`,
        paragraphs: [`Formulation: ${proc.formulation ?? '—'}. ${proc.disclaimer}`],
        tables: [
          { caption: 'Summary (calculated)', headers: ['Feed kg/h', 'Product kg/h', 'Evaporated kg/h', 'Power kW', 'kWh/kg', 'Operating €/kg'], rows: [[fmt(s.feed_kg_h as number, 1), fmt(s.product_kg_h as number, 1), fmt(s.evaporated_kg_h as number, 2), fmt(s.total_power_kw as number, 2), fmt(s.specific_energy_kwh_per_kg_product as number, 3), fmt(s.operating_cost_eur_per_kg_product as number, 3)]] },
          { caption: 'Units', headers: ['Unit', 'Mass out kg/h', 'T out °C', 'τ s', 'P kW', 'ΔP bar'], rows: proc.units.map((u) => [u.label, fmt(u.outputs.outlet_mass_flow_kg_h, 2), fmt(u.outputs.outlet_temperature_c, 1), fmt(u.outputs.mean_residence_time_s ?? u.outputs.residence_time_s, 1), fmt(u.outputs.electrical_power_kw, 3), fmt(u.outputs.pressure_drop_bar ?? u.outputs.die_pressure_drop_bar, 3)]) },
        ],
        bullets: [...new Set(proc.units.flatMap((u) => u.unsupported))].map((u) => `Not supported: ${u}`).concat([`Excludes: ${s.excludes}`]),
      })
    }
    const pr = results.print as Record<string, unknown> | undefined
    const pp = results.printParams as Record<string, unknown> | undefined
    if (sel.print && pr && pp) {
      const g = pp.geometry as Record<string, number>
      out.push({
        title: '3D printing',
        tables: [
          { caption: 'Printer parameters', headers: ['Shape', 'Nozzle Ø mm', 'Nozzle L mm', 'Layer h mm', 'Speed mm/s', 'Extrusion °C', 'Bed °C', 'Infill %'], rows: [[`${pp.shape} (H ${g.height} mm)`, pp.nozzle_diameter_mm as number, pp.nozzle_length_mm as number, pp.layer_height_mm as number, pp.print_speed_mm_s as number, pp.extrusion_temperature_c as number, pp.bed_temperature_c as number, pp.infill_pct as number]] },
          { caption: 'Print estimate (calculated)', headers: ['Layers', 'Print time min', 'Toolpath m', 'Extrusion m', 'Volume cm³', 'Mass g', 'Required flow mm³/s'], rows: [[pr.layer_count as number, fmt((pr.print_time_s as number) / 60, 1), fmt((pr.toolpath_length_mm as number) / 1000, 2), fmt((pr.extrusion_length_mm as number) / 1000, 2), fmt(pr.deposited_volume_cm3 as number, 2), fmt(pr.material_mass_g as number, 1), fmt(pr.required_volumetric_flow_mm3_s as number, 2)]] },
        ],
        bullets: [...(pr.warnings as string[]), ...(pr.unsupported as string[]).map((u) => `Not predicted: ${u}`), ...(pr.assumptions as string[])],
      })
    }
    const rec = results.recommendation as { phase: string; method: string; reason: string; warnings?: string[]; cv?: { q2: number }; recommendations: { rank: number; composition: Record<string, number>; names: Record<string, string>; predicted?: number }[] } | undefined
    if (sel.recommendation && rec && rec.recommendations.length) {
      const ids = Object.keys(rec.recommendations[0].composition)
      out.push({
        title: 'Experimental recommendations',
        paragraphs: [`Phase: ${rec.phase.replace(/_/g, ' ')}. ${rec.method} ${rec.reason}${rec.cv ? ` Leave-one-out Q² = ${fmt(rec.cv.q2, 2)}.` : ''}`],
        tables: [{ headers: ['#', ...ids.map((i) => `${rec.recommendations[0].names[i]} %`), ...(rec.phase === 'active_learning' ? ['Predicted'] : [])], rows: rec.recommendations.map((r) => [r.rank, ...ids.map((i) => fmt(r.composition[i], 2)), ...(rec.phase === 'active_learning' ? [fmt(r.predicted, 2)] : [])]) }],
        bullets: rec.warnings,
      })
    }
    const sc = results.scenario as Record<string, number | null | string> | undefined
    const si = results.scenarioInputs as Record<string, number> | undefined
    if (sel.scenario && sc && si) {
      out.push({
        title: 'Experimental cost-saving scenario (illustrative)',
        paragraphs: [String(sc.label)],
        tables: [
          { caption: 'Inputs (assumptions)', headers: ['Conventional exp.', 'Planned exp.', '€/experiment', 'kg/experiment', 'Software & modelling €'], rows: [[si.conventional_experiments, si.planned_experiments, si.cost_per_experiment, si.material_per_experiment_kg, si.software_modelling_cost]] },
          { caption: 'Results (calculated)', headers: ['Conventional €', 'Planned €', 'Gross avoided €', 'Net savings €', 'Reduction %', 'Material saved kg'], rows: [[fmt(sc.conventional_cost as number, 0), fmt(sc.planned_cost as number, 0), fmt(sc.gross_avoided as number, 0), fmt(sc.net_savings as number, 0), fmt(sc.experiment_reduction_pct as number, 0), fmt(sc.material_saved_kg as number, 0)]] },
        ],
      })
    }
    return out
  }

  const pdf = async () => {
    setBusy(true)
    try {
      const sections = build()
      if (!sections.length) throw new Error('No sections with results selected.')
      const blob = await api.blob('/api/reports/pdf', { title: `${project?.name} — Synthea Simulation report`, project: project?.name, sections })
      download(`${(project?.name ?? 'report').replace(/\W+/g, '_')}_report.pdf`, blob)
      toast('PDF report generated', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const json = () => {
    const payload = { format: 'synthea-report/1', generated: new Date().toISOString(), project, active_formulation: active, formulation_result: evalRes, results }
    download(`${(project?.name ?? 'report').replace(/\W+/g, '_')}_results.json`, JSON.stringify(payload, null, 2))
  }
  const csv = () => {
    const rows: (string | number | null | undefined)[][] = [['section', 'item', 'field', 'value']]
    if (evalRes && active) {
      active.lines.forEach((l) => rows.push(['formulation', ingMap[l.ingredient_id]?.name, 'mass_pct', l.percent]))
      Object.entries(evalRes.composition).forEach(([k, v]) => rows.push(['nutrition', active.name, k, v]))
      rows.push(['cost', active.name, 'eur_per_kg', evalRes.cost_per_kg], ['cost', active.name, 'eur_per_serving', evalRes.cost_per_serving])
    }
    const opt = results.optimization as OptimizationResult | undefined
    opt?.candidates.filter((c) => c.formulation).forEach((c) => {
      c.formulation!.forEach((l) => rows.push(['optimization', c.label, `${l.ingredient_id}_pct`, l.percent]))
      rows.push(['optimization', c.label, 'protein_pct', c.composition?.protein], ['optimization', c.label, 'cost_eur_kg', c.cost_per_kg])
    })
    const sc = results.scenario as Record<string, unknown> | undefined
    if (sc) Object.entries(sc).filter(([, v]) => typeof v === 'number').forEach(([k, v]) => rows.push(['scenario', 'illustrative', k, v as number]))
    const pr = results.print as Record<string, unknown> | undefined
    if (pr) ['layer_count', 'print_time_s', 'toolpath_length_mm', 'deposited_volume_cm3', 'material_mass_g'].forEach((k) => rows.push(['print', String(pr.shape), k, pr[k] as number]))
    download(`${(project?.name ?? 'report').replace(/\W+/g, '_')}_results.csv`, toCsv(rows), 'text/csv')
  }

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <PageHeader title="Reports" subtitle="Export formulations, calculations, optimisation, process and printing results with scientific assumptions and limitations." actions={<>
        <Button onClick={json}><FileJson className="h-3.5 w-3.5" />Export JSON</Button>
        <Button onClick={csv}><FileSpreadsheet className="h-3.5 w-3.5" />Export CSV</Button>
        <Button variant="primary" onClick={pdf} loading={busy}><FileDown className="h-3.5 w-3.5" />Generate PDF report</Button>
      </>} />
      <Panel title="Report sections">
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {SECTIONS.map((s) => (
            <label key={s.id} className="flex items-center gap-3 py-2 text-sm">
              <input type="checkbox" checked={sel[s.id]} onChange={(e) => setSel({ ...sel, [s.id]: e.target.checked })} />
              {available[s.id] ? <CheckCircle2 className="h-4 w-4 text-accent" /> : <Circle className="h-4 w-4 text-neutral-300" />}
              <div className="flex-1">
                <div className="font-medium">{s.title}</div>
                <div className="text-[11px] text-neutral-500">Source: {s.source}{!available[s.id] && <> — not yet available. <Link className="text-accent underline" to={s.to}>Run it</Link></>}</div>
              </div>
            </label>
          ))}
          <div className="flex items-center gap-3 py-2 text-sm"><input type="checkbox" checked disabled /><CheckCircle2 className="h-4 w-4 text-accent" /><div><div className="font-medium">Scientific assumptions & limitations</div><div className="text-[11px] text-neutral-500">Always included</div></div></div>
        </div>
      </Panel>
      <Alert>Results are taken from the latest runs in this browser session for the selected project (stored locally). Each table in the PDF states whether values are calculated, predicted or illustrative.</Alert>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">Provenance labels used: {['measured', 'literature', 'calculated', 'predicted', 'illustrative', 'synthetic', 'missing'].map((k) => <Prov key={k} kind={k} />)}</div>
    </div>
  )
}
