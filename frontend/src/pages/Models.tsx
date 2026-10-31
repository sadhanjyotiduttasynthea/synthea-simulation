import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Equation } from '../components/Equation'
import { Alert, Badge, Button, Input, PageHeader, Panel, Select } from '../components/ui'
import { api } from '../lib/api'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'

export interface EqRow {
  origin: string; model_id?: string; extraction_id?: string; name?: string; template?: string | null; latex?: string; expression?: string; raw?: string
  dependent?: { symbol: string; name?: string; unit?: string }; variables: { symbol: string; name?: string; unit?: string }[]
  parameters: { symbol: string; name?: string; value: number | null; unit?: string | null }[]; parameter_sets?: number
  validity: Record<string, [number, number]>; conditions?: Record<string, number>; material?: string | null; status: string
  paper_id?: string | null; paper?: string | null; page?: number | null; synthetic?: boolean
}

const fmt = (v: number | null | undefined) => (v == null ? '—' : Math.abs(v) !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? v.toExponential(3) : String(+v.toPrecision(5)))
const unit = (u?: string | null) => (u ?? '').replace(/\*\*n/g, 'ⁿ').replace(/\*\*2/g, '²').replace(/\*/g, '·').replace('degC', '°C')

/** Equations and numerical models: everything extracted from papers plus the approved registry. */
export function EquationTable({ rows, onStatus }: { rows: EqRow[]; onStatus?: (r: EqRow, s: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="border-b border-neutral-300 text-left text-[10.5px] uppercase tracking-wide text-neutral-500 dark:border-white/15">
          <th className="py-1 pr-2">Model / formula</th><th className="pr-2">Variables</th><th className="pr-2">Parameters</th><th className="pr-2">Validity</th><th className="pr-2">Material</th><th className="pr-2">Source</th><th>Status</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={(r.model_id ?? r.extraction_id ?? '') + i} className="border-b border-neutral-200 align-top dark:border-white/10">
              <td className="max-w-[300px] py-1.5 pr-2">
                <div className="font-medium">{r.name ?? 'Equation'}</div>
                {r.latex ? <Equation latex={r.latex} className="block overflow-x-auto py-0.5" /> : <code className="block whitespace-pre-wrap text-[11px] text-neutral-500">{r.raw}</code>}
                {r.expression && <code className="text-[10px] text-neutral-500">{r.expression}</code>}
              </td>
              <td className="pr-2">
                {r.dependent && <div><b>{r.dependent.symbol}</b> {r.dependent.name} [{unit(r.dependent.unit) || '–'}]</div>}
                {r.variables.map((v) => <div key={v.symbol}>{v.symbol}: {v.name} [{unit(v.unit) || '–'}]</div>)}
              </td>
              <td className="num pr-2">
                {r.parameters.map((p) => <div key={p.symbol} className={p.value == null ? 'text-amber-700 dark:text-amber-400' : ''}>{p.symbol} = {p.value == null ? 'missing' : `${fmt(p.value)} ${unit(p.unit)}`}</div>)}
                {!!r.parameter_sets && <div className="text-neutral-500">{r.parameter_sets} fitted parameter set(s) in a table</div>}
              </td>
              <td className="pr-2">{Object.keys(r.validity ?? {}).length ? Object.entries(r.validity).map(([k, [a, b]]) => <div key={k}>{k}: {fmt(a)}–{fmt(b)}</div>) : <span className="text-amber-700 dark:text-amber-400">not stated</span>}
                {r.conditions && Object.keys(r.conditions).length > 0 && <div className="text-neutral-500">{Object.entries(r.conditions).map(([k, v]) => `${k} ${v}`).join(', ')}</div>}</td>
              <td className="pr-2">{r.material ?? '—'}</td>
              <td className="pr-2">
                {r.paper_id ? <Link className="inline-flex items-center gap-0.5 text-rose-600 underline" to={`/papers?paper=${r.paper_id}&tab=review`}>{r.paper}{r.page ? `, p. ${r.page}` : ''}<ExternalLink className="h-3 w-3" /></Link> : <span className="text-neutral-500">{r.paper}</span>}
                {r.synthetic && <span className="ml-1 rounded bg-red-600 px-1 text-[9px] text-white">SYNTHETIC</span>}
              </td>
              <td>
                <Badge tone={r.status === 'approved' || r.status === 'validated' ? 'green' : r.status.startsWith('unrecognised') ? 'red' : 'amber'}>{r.status}</Badge>
                <div className="text-[10px] text-neutral-500">{r.origin}</div>
                {onStatus && r.model_id && r.status !== 'approved' && r.status !== 'validated' && <button className="mt-0.5 flex items-center gap-0.5 text-[11px] text-emerald-700 underline" onClick={() => onStatus(r, 'approved')}><CheckCircle2 className="h-3 w-3" />approve for calculation</button>}
                {onStatus && r.model_id && <button className="flex items-center gap-0.5 text-[11px] text-neutral-500 underline" onClick={() => onStatus(r, 'deprecated')}><XCircle className="h-3 w-3" />deprecate</button>}
                {r.extraction_id && <Link className="text-[11px] text-rose-600 underline" to={`/papers?paper=${r.paper_id}&tab=review`}>review</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Models() {
  const toast = useStore((s) => s.toast)
  const [rows, setRows] = useState<EqRow[]>([])
  const [q, setQ] = useState('')
  const [st, setSt] = useState('')
  const load = () => api.get<EqRow[]>('/api/equations').then(setRows)
  useEffect(() => { load() }, [])
  useCommand('model.new', () => toast('New models are created by approving an extracted equation (Papers → Extraction Review) or with the manual-entry fallback there.', 'info'))
  const shown = useMemo(() => rows.filter((r) => (!st || r.status === st || (st === 'pending' && r.status.startsWith('unrecognised'))) && (!q || `${r.name} ${r.material} ${r.paper} ${r.template}`.toLowerCase().includes(q.toLowerCase()))), [rows, q, st])
  const setStatus = async (r: EqRow, s: string) => {
    await api.post(`/api/sci-models/${r.model_id}/status`, { status: s })
    toast(`Model ${s}`, 'success')
    load()
    refreshTree()
  }
  return (
    <div className="space-y-3">
      <PageHeader title="Models — equations and numerical models" subtitle="Every equation extracted from your papers (awaiting review or unrecognised) and every registry model, with formula, variables, units, parameter values, validity range and source. Only approved models are used in calculations." />
      <Panel title={`Equations and models (${shown.length})`} actions={<>
        <Input placeholder="Search name, material, paper…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
        <Select value={st} onChange={(e) => setSt(e.target.value)} className="w-40"><option value="">All statuses</option><option value="approved">Approved</option><option value="reviewed">Reviewed</option><option value="pending">Awaiting review</option></Select>
        <Button size="sm" onClick={load}>Refresh</Button>
      </>}>
        {rows.length === 0 ? <Alert>No equations yet. Import papers (Papers), run extraction and review the candidates. Recognised templates: power law, Herschel–Bulkley, Arrhenius viscosity, first-order / Arrhenius denaturation kinetics, GAB sorption, Fourier conduction. Other equations go through manual entry.</Alert>
          : <EquationTable rows={shown} onStatus={setStatus} />}
      </Panel>
    </div>
  )
}
