import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Alert, Badge, Button, Spinner } from './ui'

export type Digest = {
  method: string
  generated_at: string
  label: string
  title?: string
  citation?: string
  text?: string
  key_sentences: { page: number; section: string | null; text: string; properties: string[] }[]
  topics: { property: string; label: string; mentions: number }[]
  materials: { material_id: string; name: string; mentions: number }[]
  abbreviations?: Record<string, string>
  sections: string[]
  page_count: number
  tables: number
  extractions: { pending: number; approved: number; rejected: number }
  warnings: string[]
}

/** Paper summary: extractive (local, verbatim sentences with page numbers) or optional external AI. */
export function PaperSummary({ paperId, onSource }: { paperId: string; onSource: (page: number, snippet?: string) => void }) {
  const [d, setD] = useState<Digest | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)


  const run = async (method: 'local' | 'claude') => {
    setBusy(true)
    setErr(null)
    try { setD(await api.post<Digest>(`/api/papers/${paperId}/summary`, { method })) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  useEffect(() => {
    setErr(null)
    api.get<Digest | null>(`/api/papers/${paperId}/summary`).then((x) => {
      if (x) setD(x)
      else { setD(null); run('local') }
    })
  }, [paperId])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full space-y-3 overflow-auto p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => run('local')} loading={busy}>Regenerate (local)</Button>
        <Button size="sm" variant="ghost" onClick={() => run('claude')} disabled={busy} title="Requires an API key and the external-AI opt-in in Settings"><Sparkles className="h-3.5 w-3.5" />Summarise with Claude</Button>
        {d && <span className="text-[11px] text-neutral-500">{d.label}</span>}
      </div>
      {busy && <Spinner label="Summarising…" />}
      {err && <Alert kind="warn">{err}</Alert>}
      {d && (
        <>
          {d.warnings.length > 0 && <Alert kind="warn">{d.warnings.join(' ')}</Alert>}
          <div className="grid gap-2 text-xs @2xl:grid-cols-4">
            <Badge>{d.page_count} pages</Badge><Badge>{d.tables} tables</Badge>
            <Badge tone="amber">{d.extractions.pending} extractions to review</Badge><Badge tone="green">{d.extractions.approved} approved</Badge>
          </div>
          {d.text && (
            <section>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">AI summary ({d.method})</h3>
              <pre className="whitespace-pre-wrap rounded border border-amber-300 bg-amber-50 p-2 font-sans text-xs leading-relaxed dark:border-amber-700/50 dark:bg-amber-950/20">{d.text}</pre>
            </section>
          )}
          <section>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Key statements (verbatim)</h3>
            <ol className="space-y-1.5">
              {d.key_sentences.map((s, i) => (
                <li key={i} className="rounded border border-neutral-200 p-2 text-xs dark:border-white/10">
                  <div>“{s.text}”</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-neutral-500">
                    <button className="text-rose-600 underline" onClick={() => onSource(s.page, s.text.slice(0, 60))}>page {s.page}</button>
                    {s.section && <span>· {s.section}</span>}
                    {s.properties.map((p) => <span key={p} className="rounded bg-neutral-100 px-1 dark:bg-white/10">{p.replaceAll('_', ' ')}</span>)}
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <div className="grid gap-3 @2xl:grid-cols-2">
            <section>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Properties discussed</h3>
              <div className="flex flex-wrap gap-1">{d.topics.map((t) => <span key={t.property} className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] dark:border-white/10">{t.label} <b>{t.mentions}</b></span>)}</div>
            </section>
            <section>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Materials recognised</h3>
              <div className="flex flex-wrap gap-1">
                {d.materials.length === 0 && <span className="text-xs text-neutral-500">No library materials mentioned.</span>}
                {d.materials.map((m) => <span key={m.material_id} className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] dark:border-white/10">{m.name} <b>{m.mentions}</b></span>)}
                {Object.entries(d.abbreviations ?? {}).map(([a, n]) => <span key={a} className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] dark:bg-white/10">{a} = {n}</span>)}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
