import { Printer, Save, Star, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useStore } from '../store'
import { Alert, Badge, Button, KV, Panel, Prov, Select, cx } from './ui'

export interface TechRow { key: string; label: string; value: number | null; unit: string; provenance: string; basis?: string | null; needs?: string | null }
export interface TextureResult {
  class: string | null; classes: string[]; label: string; source: string | null; provenance: string; hardness_n?: number; hardness_sd_n?: number | null
  interval_n?: [number, number]; band?: string; loo_q2?: number; n_training?: number; n?: number; warnings?: string[]; needs?: string[]; note?: string
  secondary?: { parameter: string; value: number | null; typical: [number, number]; status: string }[]
  scheme: { protocol: string; provenance: string; note?: string }
}
interface Run { id: string; name: string; created: string; formulation_name?: string; flow_name?: string; summary: { technical?: TechRow[]; specific_energy_kwh_per_kg_product?: number; product_kg_h?: number }; texture?: TextureResult | null }

const f = (v: number | null | undefined, d = 3) => (v == null ? '—' : String(+v.toPrecision(d)))
const PROV_LABEL: Record<string, string> = { missing: 'missing' }

export function TechnicalOutputs({ rows }: { rows: TechRow[] }) {
  return (
    <Panel title="Technical outputs" subtitle="Each value with its provenance and basis.">
      <table className="w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key + r.label} className="border-b border-neutral-100 dark:border-white/5">
              <td className="py-1 pr-2">{r.label}</td>
              <td className="num pr-2 text-right font-medium">{r.value == null ? <span className="text-amber-700 dark:text-amber-400">not computed</span> : `${f(r.value, 4)} ${r.unit}`}</td>
              <td className="pr-2"><Prov kind={PROV_LABEL[r.provenance] ?? r.provenance} /></td>
              <td className="text-[10.5px] text-neutral-500">{r.needs ? `needs ${r.needs}` : r.basis}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

/** Texture Class ID (TX-01 … TX-05) of the formulation with its source and uncertainty. */
export function ProcessTexture({ projectId, formulationId, onResult }: { projectId: string; formulationId: string; onResult: (t: TextureResult) => void }) {
  const [mats, setMats] = useState<{ id: string; name: string }[]>([])
  const [mat, setMat] = useState('')
  const [t, setT] = useState<TextureResult | null>(null)
  useEffect(() => { api.get<{ id: string; name: string }[]>('/api/materials').then(setMats) }, [])
  useEffect(() => {
    api.post<TextureResult>('/api/process/texture', { project_id: projectId, formulation_id: formulationId, product_material_id: mat || null }).then((r) => { setT(r); onResult(r) })
  }, [projectId, formulationId, mat])  // eslint-disable-line react-hooks/exhaustive-deps
  if (!t) return null
  return (
    <Panel title="Texture Class ID" subtitle={`Classes TX-01 (soft paste) … TX-05 (firm, fibrous, meat-like) from TPA hardness bands. Protocol: ${t.scheme.protocol}.`}
      actions={<Select value={mat} onChange={(e) => setMat(e.target.value)} className="w-56" title="Library material holding approved TPA records of this product"><option value="">Product material: none</option>{mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={cx('rounded px-2 py-1 text-lg font-semibold', t.class ? 'bg-rose-600 text-white' : t.classes.length ? 'bg-amber-500 text-white' : 'bg-neutral-200 text-neutral-700 dark:bg-white/10 dark:text-neutral-300')}>{t.label}</span>
        <Prov kind={t.provenance} />
        {t.source && <span className="text-xs text-neutral-500">from {t.source}</span>}
      </div>
      {t.hardness_n != null && <div className="mt-2"><KV rows={[
        ['Hardness', `${f(t.hardness_n)} N${t.hardness_sd_n ? ` ± ${f(t.hardness_sd_n, 2)} (SD)` : ''}`],
        ['Band used for classification', t.interval_n ? `${f(t.interval_n[0])} – ${f(t.interval_n[1])} N${t.band ? ` (${t.band})` : ''}` : '—'],
        ...(t.loo_q2 != null ? [['Surrogate LOO Q² / training points', `${f(t.loo_q2, 2)} / ${t.n_training}`] as [string, string]] : []),
        ...(t.n ? [['Replicates', String(t.n)] as [string, string]] : []),
      ]} /></div>}
      {t.secondary && t.secondary.length > 0 && <div className="mt-2 flex flex-wrap gap-1 text-[11px]">{t.secondary.map((s) => <Badge key={s.parameter} tone={s.status === 'typical' ? 'green' : s.status === 'not measured' ? 'neutral' : 'amber'}>{s.parameter}: {s.value == null ? 'not measured' : f(s.value)} (typical {s.typical[0]}–{s.typical[1]})</Badge>)}</div>}
      {t.warnings?.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
      {t.needs && <Alert kind="warn" title="Unclassified">Needs: {t.needs.join('; ')}</Alert>}
      <p className="mt-1 text-[10.5px] text-neutral-500">{t.note} Class ranges: {t.scheme.provenance} convention — {t.scheme.note}</p>
    </Panel>
  )
}

/** Save runs, compare them side by side and mark one as the optimized product (sent to Synthea Print). */
export function ProcessRuns({ projectId, current }: { projectId: string; current: Record<string, unknown> & { summary?: unknown } }) {
  const toast = useStore((s) => s.toast)
  const nav = useNavigate()
  const [runs, setRuns] = useState<Run[]>([])
  const [optimized, setOptimized] = useState<string | null>(null)
  const load = () => {
    api.get<Run[]>(`/api/process/runs?project_id=${projectId}`).then(setRuns)
    api.get<{ optimized_product?: { run_id: string } }>(`/api/projects/${projectId}`).then((p) => setOptimized(p.optimized_product?.run_id ?? null))
  }
  useEffect(load, [projectId])  // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { await api.post('/api/process/runs', { project_id: projectId, ...current }); toast('Run saved', 'success'); load() }
  const mark = async (id: string) => { await api.post(`/api/process/runs/${id}/optimized`); toast('Marked as optimized product — available in Synthea Print', 'success'); load() }
  const del = async (id: string) => { await api.del(`/api/process/runs/${id}`); load() }
  const keys = Array.from(new Set(runs.flatMap((r) => (r.summary.technical ?? []).map((t) => t.label))))
  const cell = (r: Run, label: string) => (r.summary.technical ?? []).find((t) => t.label === label)
  return (
    <Panel title={`Runs (${runs.length})`} subtitle="Compare runs side by side; mark one as the optimized product for Synthea Print."
      actions={<><Button size="sm" onClick={save}><Save className="h-3.5 w-3.5" />Save current run</Button>{optimized && <Button size="sm" onClick={() => nav('/printing')}><Printer className="h-3.5 w-3.5" />To Synthea Print</Button>}</>}>
      {runs.length === 0 ? <p className="text-xs text-neutral-500">No saved runs yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="border-b text-left text-[10px] uppercase text-neutral-500"><th className="py-1">Output</th>{runs.map((r) => (
              <th key={r.id} className="px-2">
                <div className="normal-case">{r.name}{optimized === r.id && <Star className="ml-1 inline h-3 w-3 fill-rose-600 text-rose-600" />}</div>
                <div className="text-[9.5px] normal-case text-neutral-400">{r.formulation_name}</div>
              </th>))}</tr></thead>
            <tbody>
              <tr className="border-b border-neutral-100 dark:border-white/5"><td className="py-1">Texture class</td>{runs.map((r) => <td key={r.id} className="px-2">{r.texture ? <>{r.texture.label} <Prov kind={r.texture.provenance} /></> : '—'}</td>)}</tr>
              {keys.map((k) => (
                <tr key={k} className="border-b border-neutral-100 dark:border-white/5"><td className="py-1">{k}</td>{runs.map((r) => { const c = cell(r, k); return <td key={r.id} className="num px-2">{c ? (c.value == null ? 'not computed' : `${f(c.value, 4)} ${c.unit}`) : '—'}</td> })}</tr>
              ))}
              <tr><td />{runs.map((r) => (
                <td key={r.id} className="space-x-1 px-2 py-1">
                  <Button size="sm" variant={optimized === r.id ? 'primary' : 'secondary'} onClick={() => mark(r.id)} disabled={optimized === r.id}><Star className="h-3 w-3" />{optimized === r.id ? 'Optimized product' : 'Mark optimized'}</Button>
                  <button onClick={() => del(r.id)} title="Delete run" className="text-neutral-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </td>))}</tr>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
