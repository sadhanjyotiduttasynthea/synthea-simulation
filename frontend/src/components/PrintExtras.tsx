import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Alert, Badge, Button, Field, KV, NumInput, Panel, Prov, Select, cx } from './ui'

export interface Extrusion { method: 'piston' | 'screw'; barrel_diameter_mm?: number; barrel_length_mm?: number; screw_diameter_mm?: number; channel_depth_mm?: number; pitch_mm?: number; fill_fraction?: number; max_speed_rpm?: number }
export interface Limits { max_pressure_kpa: number; overhang_limit_deg: number; thin_fraction_max: number; max_print_time_min: number; max_layers: number; shape_retention_safety: number }
export const DEFAULT_EXTRUSION: Extrusion = { method: 'piston', barrel_diameter_mm: 22, barrel_length_mm: 100, screw_diameter_mm: 10, channel_depth_mm: 2, pitch_mm: 8, fill_fraction: 0.8, max_speed_rpm: 120 }
export const DEFAULT_LIMITS: Limits = { max_pressure_kpa: 600, overhang_limit_deg: 45, thin_fraction_max: 0.05, max_print_time_min: 60, max_layers: 200, shape_retention_safety: 1 }

interface Check { id: string; label: string; status: string; value?: number; unit?: string; threshold?: string; margin?: number; score?: number; weight: number; provenance?: string; needs?: string; inputs?: Record<string, unknown> }
export interface Manufacturability { score_pct: number | null; based_on: string; label: string; checks: Check[]; weights: Record<string, number>; limiting: { id: string; label: string; status: string; advice: string } | null; formula: string; limits_provenance: string }
export interface ExtrusionResult { method: string; required_flow_mm3_s: number; ram_speed_mm_s?: number; ram_displacement_mm?: number; barrel_capacity_mm3?: number; refills?: number; ram_force_n?: number | null; screw_speed_rpm?: number; displacement_per_rev_mm3?: number; revolutions_total?: number; e_axis: string; model: string; warnings: string[]; pressure: { value_kpa: number | null; status: string; basis: string } }

const f = (v: number | null | undefined, d = 3) => (v == null ? '—' : String(+v.toPrecision(d)))

export function ExtrusionSettings({ ex, onChange }: { ex: Extrusion; onChange: (e: Extrusion) => void }) {
  const set = (k: keyof Extrusion, v: number | null) => onChange({ ...ex, [k]: v ?? undefined })
  return (
    <Panel title="Extrusion system">
      <Field label="Method"><Select value={ex.method} onChange={(e) => onChange({ ...ex, method: e.target.value as Extrusion['method'] })}><option value="piston">Piston / syringe (ram)</option><option value="screw">Screw / auger</option></Select></Field>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {ex.method === 'piston' ? <>
          <Field label="Barrel Ø [mm]"><NumInput value={ex.barrel_diameter_mm ?? null} onChange={(v) => set('barrel_diameter_mm', v)} /></Field>
          <Field label="Barrel length [mm]"><NumInput value={ex.barrel_length_mm ?? null} onChange={(v) => set('barrel_length_mm', v)} /></Field>
        </> : <>
          <Field label="Screw Ø [mm]"><NumInput value={ex.screw_diameter_mm ?? null} onChange={(v) => set('screw_diameter_mm', v)} /></Field>
          <Field label="Channel depth [mm]"><NumInput value={ex.channel_depth_mm ?? null} onChange={(v) => set('channel_depth_mm', v)} /></Field>
          <Field label="Pitch [mm]"><NumInput value={ex.pitch_mm ?? null} onChange={(v) => set('pitch_mm', v)} /></Field>
          <Field label="Fill fraction [–]"><NumInput value={ex.fill_fraction ?? null} onChange={(v) => set('fill_fraction', v)} /></Field>
          <Field label="Max speed [rpm]"><NumInput value={ex.max_speed_rpm ?? null} onChange={(v) => set('max_speed_rpm', v)} /></Field>
        </>}
      </div>
      <p className="mt-1 text-[10px] text-neutral-500">{ex.method === 'piston' ? 'Ram speed and displacement follow from the bead flow; force = nozzle pressure × barrel area.' : 'Screw speed from positive-displacement conveying; leakage/back-flow not modelled.'} Pressure uses Herschel–Bulkley capillary flow; without rheology it is not computed.</p>
    </Panel>
  )
}

export function LimitSettings({ lim, prov, onChange, onProv }: { lim: Limits; prov: string; onChange: (l: Limits) => void; onProv: (p: string) => void }) {
  const set = (k: keyof Limits, v: number | null) => onChange({ ...lim, [k]: v ?? DEFAULT_LIMITS[k] })
  return (
    <Panel title="Printer limits (manufacturability)">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Max pressure [kPa]"><NumInput value={lim.max_pressure_kpa} onChange={(v) => set('max_pressure_kpa', v)} /></Field>
        <Field label="Overhang limit [°]"><NumInput value={lim.overhang_limit_deg} onChange={(v) => set('overhang_limit_deg', v)} /></Field>
        <Field label="Max thin area [%]"><NumInput value={lim.thin_fraction_max * 100} onChange={(v) => set('thin_fraction_max', v == null ? null : v / 100)} /></Field>
        <Field label="τ₀/ρgH required [–]"><NumInput value={lim.shape_retention_safety} onChange={(v) => set('shape_retention_safety', v)} /></Field>
        <Field label="Max print time [min]"><NumInput value={lim.max_print_time_min} onChange={(v) => set('max_print_time_min', v)} /></Field>
        <Field label="Max layers"><NumInput value={lim.max_layers} onChange={(v) => set('max_layers', v)} /></Field>
      </div>
      <Field label="Source of these limits" className="mt-2"><Select value={prov} onChange={(e) => onProv(e.target.value)}><option value="illustrative">illustrative defaults</option><option value="printer specification">printer specification</option><option value="measured">measured on our printer</option></Select></Field>
    </Panel>
  )
}

export function ExtrusionResults({ ex }: { ex: ExtrusionResult }) {
  return (
    <Panel title={`Extrusion system — ${ex.method === 'piston' ? 'piston' : 'screw'}`} actions={<Prov kind="calculated" />}>
      <KV rows={[
        ['Required flow', `${f(ex.required_flow_mm3_s)} mm³/s`],
        ...(ex.method === 'piston' ? [
          ['Ram speed', `${f(ex.ram_speed_mm_s)} mm/s`], ['Ram displacement (whole object)', `${f(ex.ram_displacement_mm)} mm`], ['Barrel refills', String(ex.refills ?? 0)],
          ['Ram force', ex.ram_force_n == null ? 'not computed — needs rheology' : `${f(ex.ram_force_n)} N`],
        ] as [string, string][] : [
          ['Displacement per revolution', `${f(ex.displacement_per_rev_mm3)} mm³`], ['Screw speed', `${f(ex.screw_speed_rpm)} rpm`], ['Revolutions (whole object)', f(ex.revolutions_total)],
        ] as [string, string][]),
        ['Nozzle pressure', ex.pressure.value_kpa == null ? 'not computed' : `${f(ex.pressure.value_kpa)} kPa`],
        ['G-code E axis', ex.e_axis],
      ]} />
      <p className="mt-1 text-[10px] text-neutral-500">{ex.model}. {ex.pressure.basis}.</p>
      {ex.warnings.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
    </Panel>
  )
}

const STATUS: Record<string, string> = { pass: 'bg-emerald-600 text-white', marginal: 'bg-amber-500 text-white', fail: 'bg-red-600 text-white', 'not evaluated': 'bg-neutral-300 text-neutral-700 dark:bg-white/15 dark:text-neutral-300' }

export function ManufacturabilityPanel({ m }: { m: Manufacturability }) {
  return (
    <Panel title="Prototype Manufacturability Score" subtitle={m.label}>
      <div className="flex items-end gap-3">
        <div className={cx('rounded px-3 py-1.5 text-2xl font-semibold tabular-nums', m.score_pct == null ? 'bg-neutral-200 dark:bg-white/10' : m.score_pct >= 80 ? 'bg-emerald-600 text-white' : m.score_pct >= 50 ? 'bg-amber-500 text-white' : 'bg-red-600 text-white')}>
          {m.score_pct == null ? '—' : `${m.score_pct.toFixed(0)} %`}
        </div>
        <div className="text-xs text-neutral-500">{m.based_on}<br /><i>compatibility index — not a success probability</i></div>
      </div>
      {m.limiting && (m.limiting.status === 'pass'
        ? <Alert title="All evaluated checks pass">Closest to its limit: {m.limiting.label}. {m.checks.some((c) => c.status === 'not evaluated') ? 'Add the missing data to evaluate the remaining checks.' : ''}</Alert>
        : <Alert kind="warn" title={`Limiting check: ${m.limiting.label} (${m.limiting.status})`}>{m.limiting.advice}</Alert>)}
      <table className="mt-2 w-full text-[11px]">
        <thead><tr className="border-b text-left text-[10px] uppercase text-neutral-500"><th>Check</th><th>Weight</th><th>Value</th><th>Threshold</th><th>Result</th></tr></thead>
        <tbody>
          {m.checks.map((c) => (
            <tr key={c.id} className="border-b border-neutral-100 align-top dark:border-white/5">
              <td className="py-1 pr-1">{c.label}<div className="text-[10px] text-neutral-500">{c.provenance ?? (c.needs ? `needs ${c.needs}` : '')}</div></td>
              <td className="pr-1">{c.weight}</td>
              <td className="num pr-1">{c.value == null ? '—' : `${f(c.value)} ${c.unit ?? ''}`}</td>
              <td className="pr-1">{c.threshold ?? '—'}</td>
              <td><span className={cx('rounded px-1 py-0.5 text-[10px] font-semibold uppercase', STATUS[c.status])}>{c.status}</span>{c.margin != null && <div className="text-[10px] text-neutral-500">margin {(c.margin * 100).toFixed(0)} %</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-neutral-500">{m.formula}. Limits: {m.limits_provenance}. Documented in SCIENTIFIC_MODELS.md.</p>
    </Panel>
  )
}

interface Optimized { run_id: string; run_name: string; formulation_id: string; formulation_name: string; texture?: { label: string; provenance: string } | null; technical?: { label: string; value: number | null; unit: string; provenance: string }[] }

/** Optimized product handed over from Synthea Process. */
export function OptimizedProduct({ projectId, onUse }: { projectId: string; onUse: (formulationId: string) => void }) {
  const [op, setOp] = useState<Optimized | null>(null)
  useEffect(() => { api.get<{ optimized_product?: Optimized }>(`/api/projects/${projectId}`).then((p) => setOp(p.optimized_product ?? null)) }, [projectId])
  if (!op) return <p className="text-[11px] text-neutral-500">No optimized product yet — mark a run in Synthea Process → Process Simulator → Runs.</p>
  return (
    <div className="space-y-1 rounded border border-rose-300 p-2 text-[11px] dark:border-rose-900">
      <div className="font-semibold">Optimized product (Synthea Process)</div>
      <div>{op.formulation_name} · run “{op.run_name}”</div>
      {op.texture && <div>Texture: <Badge>{op.texture.label}</Badge> <Prov kind={op.texture.provenance} /></div>}
      {op.technical?.filter((t) => t.value != null).slice(0, 3).map((t) => <div key={t.label} className="text-neutral-500">{t.label}: {f(t.value, 4)} {t.unit}</div>)}
      <Button size="sm" onClick={() => onUse(op.formulation_id)}>Use this formulation</Button>
    </div>
  )
}
