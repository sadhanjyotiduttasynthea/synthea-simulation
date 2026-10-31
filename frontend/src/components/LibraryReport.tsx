import { Download, ExternalLink, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { EquationTable, type EqRow } from '../pages/Models'
import { api, download } from '../lib/api'
import { Alert, Badge, Button, Modal, Spinner } from './ui'

type Cond = Record<string, number | string>
interface PropRow { origin: string; material: string; label: string; value: number | null; value_max?: number | null; unit?: string; uncertainty: { value?: number }; conditions: Cond; paper_id: string; paper: string; page: number | null; status: string; synthetic: boolean }
interface Report {
  library: { id: string; name: string }; generated_at: string; method: string; label: string; warnings: string[]
  counts: { papers: number; property_values: number; approved: number; awaiting_review: number; equations: number }
  papers: { paper_id: string; title: string; citation?: string; synthetic: boolean; species?: Record<string, number>; key_statements: { page: number; text: string }[]; topics: string[] }[]
  properties: PropRow[]; equations: EqRow[]
  key_numbers: { material: string; label: string; unit: string; min: number; max: number; n_values: number; n_papers: number }[]
  disagreements: { material: string; label: string; unit: string; relative_difference: number; a: PropSide; b: PropSide }[]
  narrative?: { model: string; text: string; numbers_removed: number; label: string }
}
interface PropSide { value: number; unit: string; conditions: Cond; paper: string; page: number; status: string }

const f = (v: number | null | undefined) => (v == null ? '–' : Math.abs(v) !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) ? v.toExponential(3) : String(+v.toPrecision(4)))
const cond = (c: Cond) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')
const H = ({ children }: { children: React.ReactNode }) => <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{children}</h3>

/** "Summarize all PDFs": combined report for one library (local extractive by default, optional Claude narrative). */
export function LibraryReport({ libId, libName, open, onClose }: { libId: string; libName: string; open: boolean; onClose: () => void }) {
  const [r, setR] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async (method: 'local' | 'claude') => {
    setBusy(true)
    setErr(null)
    try { setR(await api.post<Report>(`/api/libraries/${libId}/report`, { method })) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { if (open) { setR(null); run('local') } }, [open, libId])  // eslint-disable-line react-hooks/exhaustive-deps
  const exportPdf = async () => r && download(`library_report_${libId}.pdf`, await api.blob(`/api/libraries/${libId}/report.pdf`, { report: r }), 'application/pdf')
  const exportJson = () => r && download(`library_report_${libId}.json`, JSON.stringify(r, null, 1))
  return (
    <Modal open={open} onClose={onClose} title={`Summary of all PDFs — ${libName}`} wide
      footer={<>
        <Button size="sm" variant="ghost" onClick={() => run('claude')} disabled={busy} title="Needs ANTHROPIC_API_KEY and the external-AI opt-in in Settings"><Sparkles className="h-3.5 w-3.5" />Add Claude narrative</Button>
        <Button size="sm" onClick={exportJson} disabled={!r}><Download className="h-3.5 w-3.5" />JSON</Button>
        <Button size="sm" variant="primary" onClick={exportPdf} disabled={!r}><Download className="h-3.5 w-3.5" />PDF</Button>
      </>}>
      <div className="max-h-[70vh] overflow-auto pr-1 text-xs">
        {busy && <Spinner label="Building report…" />}
        {err && <Alert kind="warn">{err}</Alert>}
        {r && (
          <>
            <p className="text-neutral-500">{r.label}</p>
            {r.warnings.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge>{r.counts.papers} papers</Badge><Badge>{r.counts.property_values} property values</Badge><Badge tone="green">{r.counts.approved} approved</Badge>
              <Badge tone="amber">{r.counts.awaiting_review} awaiting review</Badge><Badge>{r.counts.equations} equations / models</Badge><Badge tone={r.disagreements.length ? 'red' : 'neutral'}>{r.disagreements.length} disagreements</Badge>
            </div>
            {r.narrative && (
              <>
                <H>Summary ({r.narrative.model})</H>
                <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700/50 dark:bg-amber-950/20">
                  <div className="mb-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300">{r.narrative.label}{r.narrative.numbers_removed ? ` (${r.narrative.numbers_removed} number(s) removed)` : ''}</div>
                  <pre className="whitespace-pre-wrap font-sans">{r.narrative.text}</pre>
                </div>
              </>
            )}
            <H>Papers and key statements (verbatim)</H>
            {r.papers.map((p) => (
              <div key={p.paper_id} className="mb-2 rounded border border-neutral-200 p-2 dark:border-white/10">
                <Link to={`/papers?paper=${p.paper_id}`} className="font-medium text-rose-600 underline">{p.title}</Link>{p.synthetic && <span className="ml-1 rounded bg-red-600 px-1 text-[9px] text-white">SYNTHETIC</span>}
                <div className="text-[10px] text-neutral-500">{p.citation} {p.species && Object.keys(p.species).length > 0 && <>· {Object.keys(p.species).join(', ')}</>}</div>
                <ul className="mt-1 list-disc pl-4">{p.key_statements.map((s, i) => <li key={i}>“{s.text}” <span className="text-neutral-500">p. {s.page}</span></li>)}</ul>
              </div>
            ))}
            <H>Consolidated property table</H>
            <div className="overflow-x-auto"><table className="w-full">
              <thead><tr className="border-b text-left text-[10px] uppercase text-neutral-500"><th>Material</th><th>Property</th><th>Value</th><th>Conditions</th><th>Source</th><th>Status</th></tr></thead>
              <tbody>{r.properties.map((x, i) => (
                <tr key={i} className="border-b border-neutral-100 dark:border-white/5">
                  <td>{x.material}</td><td>{x.label}</td>
                  <td className="num">{f(x.value)}{x.value_max != null ? `–${f(x.value_max)}` : ''}{x.uncertainty?.value != null ? ` ± ${f(x.uncertainty.value)}` : ''} {x.unit}</td>
                  <td>{cond(x.conditions)}</td>
                  <td><Link className="text-rose-600 underline" to={`/papers?paper=${x.paper_id}&tab=review`}>p. {x.page}</Link> <span className="text-neutral-500">{x.paper?.slice(0, 40)}</span></td>
                  <td><Badge tone={x.status === 'approved' ? 'green' : x.status === 'pending' ? 'amber' : 'neutral'}>{x.status}</Badge></td>
                </tr>))}</tbody>
            </table></div>
            <H>Equations and numerical models</H>
            <EquationTable rows={r.equations} />
            <H>Key numbers (range of reported values — not averaged)</H>
            <table className="w-full"><tbody>{r.key_numbers.map((k, i) => (
              <tr key={i} className="border-b border-neutral-100 dark:border-white/5"><td>{k.material}</td><td>{k.label}</td><td className="num">{k.min === k.max ? f(k.min) : `${f(k.min)} – ${f(k.max)}`} {k.unit}</td><td className="text-neutral-500">{k.n_values} value(s), {k.n_papers} paper(s)</td></tr>))}</tbody></table>
            <H>Where sources disagree (comparable conditions, &gt; 25 %)</H>
            {r.disagreements.length === 0 ? <p className="text-neutral-500">No disagreements among comparable values.</p> : r.disagreements.map((d, i) => (
              <div key={i} className="mb-1.5 grid gap-2 rounded border border-red-200 p-2 @2xl:grid-cols-[150px_1fr_1fr] dark:border-red-900/50">
                <div><b>{d.material}</b><br />{d.label}<br /><span className="text-red-600">{(d.relative_difference * 100).toFixed(0)} % apart</span></div>
                {[d.a, d.b].map((s, j) => <div key={j}><span className="num font-semibold">{f(s.value)} {s.unit}</span> <span className="text-neutral-500">{cond(s.conditions)}</span><br />{s.paper}, p. {s.page} <Badge>{s.status}</Badge></div>)}
              </div>
            ))}
            <p className="mt-3 flex items-center gap-1 text-[10px] text-neutral-500"><ExternalLink className="h-3 w-3" />Links open the source page in Papers → Extraction Review.</p>
          </>
        )}
      </div>
    </Modal>
  )
}
