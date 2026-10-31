import { BookOpen, FileText, FileUp, FlaskConical, Table2, Trash2, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageViewer } from '../components/PageViewer'
import { Alert, Badge, Button, Field, Input, PageHeader, Panel, Spinner, Tabs, cx } from '../components/ui'
import { api, pickFile } from '../lib/api'
import type { Library } from '../lib/sci'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector } from '../workspace/Slots'
import { log, useWs } from '../workspace/wsStore'
import { ExtractionReview } from './ExtractionReview'

export interface PaperMeta { title?: string; authors?: string[]; journal?: string | null; year?: number | null; doi?: string | null; citation?: string; verified?: boolean; detection?: Record<string, string | null>; note?: string }
export interface Paper {
  id: string; name: string; page_count: number; imported_at: string; metadata: PaperMeta; warnings: string[]; library_ids: string[]
  status: string; synthetic_test_document?: boolean; size_bytes?: number; extraction_counts?: Record<string, number>
  pages?: { n: number; text: string; chars: number; width: number; height: number; tables: { id: string; rows: string[][] }[]; has_images: boolean }[]
}
type Tab = 'review' | 'preview' | 'text' | 'tables' | 'metadata'

export default function Papers() {
  const { toast } = useStore()
  const select = useWs((s) => s.select)
  const [params, setParams] = useSearchParams()
  const [list, setList] = useState<Paper[]>([])
  const [paper, setPaper] = useState<Paper | null>(null)
  const [tab, setTab] = useState<Tab>('review')
  const [page, setPage] = useState(1)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [libs, setLibs] = useState<Library[]>([])
  const [showList, setShowList] = useState(true)
  const pid = params.get('paper')

  const load = useCallback(() => api.get<Paper[]>('/api/papers').then((l) => { setList(l); if (!pid && l[0]) setParams({ paper: l[0].id }, { replace: true }) }), [pid, setParams])
  useEffect(() => { load(); api.get<Library[]>('/api/libraries').then(setLibs) }, [load])
  useEffect(() => {
    if (!pid) return setPaper(null)
    api.get<Paper>(`/api/papers/${pid}`).then((p) => { setPaper(p); setPage(1); setHighlight(null); select({ kind: 'paper', id: p.id, label: p.metadata.title }) }).catch(() => setPaper(null))
  }, [pid, select])

  const upload = async (files: File[]) => {
    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf')
    if (!pdfs.length) return toast('Only PDF files can be imported', 'error')
    for (const f of pdfs) {
      setBusy(`Importing ${f.name}…`)
      try {
        const p = await api.upload<Paper & { duplicate?: boolean }>('/api/papers', f, f.name)
        log(p.duplicate ? 'warn' : 'success', 'papers', p.duplicate ? `${f.name} is already in the library (same file hash)` : `Imported ${f.name}: ${p.page_count} pages${p.warnings.length ? `, ${p.warnings.length} warning(s)` : ''}`)
        p.warnings.forEach((w) => log('warn', 'papers', `${f.name}: ${w}`))
        setParams({ paper: p.id })
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, 'error')
      }
    }
    setBusy(null)
    await load()
    refreshTree()
  }
  const importDialog = async () => {
    try { await upload([await pickFile('.pdf')]) } catch { /* cancelled */ }
  }
  useCommand('paper.import', importDialog)
  const sample = async () => {
    setBusy('Generating synthetic test document…')
    const p = await api.post<Paper>('/api/papers/sample')
    log('info', 'papers', 'Imported the SYNTHETIC test document (values invented for software testing).')
    setBusy(null)
    await load()
    refreshTree()
    setParams({ paper: p.id })
  }
  const remove = async () => {
    if (!paper || !confirm(`Delete "${paper.metadata.title}" and its unreviewed extractions? The stored PDF file is removed.`)) return
    try {
      await api.del(`/api/papers/${paper.id}`)
      setParams({})
      await load()
      refreshTree()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const saveMeta = async (m: PaperMeta, library_ids: string[]) => {
    if (!paper) return
    const p = await api.put<Paper>(`/api/papers/${paper.id}`, { metadata: { ...m, verified: true, citation: undefined }, library_ids })
    setPaper({ ...paper, metadata: p.metadata, library_ids: p.library_ids })
    load()
    refreshTree()
    toast('Bibliographic metadata saved (marked verified)', 'success')
  }
  const goto = (pageN: number, snippet?: string | null) => {
    setPage(pageN)
    setHighlight(snippet ?? null)
    if (tab !== 'review') setTab('preview')
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    upload(Array.from(e.dataTransfer.files))
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Research Papers" subtitle="PDFs are stored locally. Text, tables and metadata are extracted on this machine; extracted values require human review before entering a library."
        actions={<>
          <Button size="sm" onClick={importDialog}><FileUp className="h-3.5 w-3.5" />Import PDF</Button>
          <Button size="sm" onClick={sample}><FlaskConical className="h-3.5 w-3.5" />Synthetic test document</Button>
        </>} />
      <div className={cx('grid min-h-0 flex-1 gap-3', showList && '@4xl:grid-cols-[220px_minmax(0,1fr)]')}>
        <div className={cx('flex min-h-0 flex-col gap-2', !showList && 'hidden')}>
          <div onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
            className={cx('flex flex-col items-center gap-1 rounded border-2 border-dashed p-4 text-center text-xs transition', drag ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/30' : 'border-neutral-300 text-neutral-500 dark:border-white/15')}>
            <FileUp className="h-6 w-6 text-rose-600" />
            <span><b>Drop PDF files here</b><br />or use Import PDF (multiple files supported)</span>
          </div>
          {busy && <Spinner label={busy} />}
          <Panel title={`Papers (${list.length})`} bodyClass="p-1" className="min-h-0 flex-1 overflow-y-auto">
            {list.length === 0 && <p className="p-2 text-xs text-neutral-500">No papers yet.</p>}
            {list.map((p) => (
              <button key={p.id} onClick={() => setParams({ paper: p.id })} className={cx('mb-0.5 w-full rounded px-2 py-1.5 text-left text-xs', p.id === pid ? 'bg-neutral-900 text-white dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>
                <div className="flex items-start gap-1.5"><BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" /><span className="line-clamp-2 font-medium">{p.metadata.title}</span></div>
                <div className="mt-0.5 flex flex-wrap gap-1 pl-5 text-[10px] opacity-80">
                  <span>{p.metadata.year ?? 'n.d.'} · {p.page_count} p.</span>
                  {p.synthetic_test_document && <span className="rounded bg-red-600 px-1 text-white">SYNTHETIC</span>}
                  {!!p.extraction_counts?.pending && <span className="rounded bg-amber-500 px-1 text-white">{p.extraction_counts.pending} to review</span>}
                  {!!p.extraction_counts?.approved && <span className="rounded bg-emerald-600 px-1 text-white">{p.extraction_counts.approved} approved</span>}
                </div>
              </button>
            ))}
          </Panel>
        </div>

        {paper ? (
          <Panel title={paper.metadata.title ?? paper.name} subtitle={paper.metadata.citation} className="flex min-h-0 flex-col" bodyClass="flex min-h-0 flex-1 flex-col p-0"
            actions={<><Button size="sm" variant="ghost" onClick={() => setShowList(!showList)} title="Show/hide paper list">{showList ? '◀ Papers' : '▶ Papers'}</Button><Button size="sm" variant="ghost" onClick={remove} title="Delete paper"><Trash2 className="h-3.5 w-3.5" /></Button></>}>
            {paper.synthetic_test_document && <div className="mx-3 mt-2 rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white">SYNTHETIC TEST DOCUMENT — generated to exercise the pipeline; all values are invented. Do not cite or use for decisions.</div>}
            {paper.warnings.length > 0 && <div className="px-3 pt-2"><Alert kind="warn" title="Import warnings">{paper.warnings.join(' ')}</Alert></div>}
            <div className="px-3 pt-1"><Tabs<Tab> value={tab} onChange={setTab} tabs={[
              { id: 'review', label: <span className="flex items-center gap-1"><Wand2 className="h-3.5 w-3.5" />Extraction & review</span> },
              { id: 'preview', label: <span className="flex items-center gap-1"><FileText className="h-3.5 w-3.5" />Document</span> },
              { id: 'text', label: 'Text' },
              { id: 'tables', label: <span className="flex items-center gap-1"><Table2 className="h-3.5 w-3.5" />Tables ({paper.pages?.reduce((s, p) => s + p.tables.length, 0) ?? 0})</span> },
              { id: 'metadata', label: 'Metadata' },
            ]} /></div>
            <div className="min-h-0 flex-1">
              {tab === 'review' && <div className="@container h-full"><ExtractionReview paper={paper} onSource={goto} page={page} highlight={highlight} onPage={setPage} onChanged={() => { load(); refreshTree() }} /></div>}
              {tab === 'preview' && paper.pages && (
                <div className="h-[calc(100%-4px)] min-h-[420px]"><PageViewer paperId={paper.id} page={page} pageCount={paper.page_count} pageWidth={paper.pages[page - 1]?.width ?? 595} highlight={highlight} onPage={(n) => { setPage(n); setHighlight(null) }} /></div>
              )}
              {tab === 'text' && (
                <div className="h-full overflow-auto p-3">
                  {paper.pages?.map((p) => (
                    <div key={p.n} className="mb-4">
                      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-neutral-500">Page {p.n} <Badge>{p.chars} characters</Badge><button className="text-rose-600 underline" onClick={() => goto(p.n)}>view</button></div>
                      <pre className="whitespace-pre-wrap rounded border border-neutral-200 bg-white p-2 font-mono text-[11px] leading-relaxed dark:border-white/10 dark:bg-[#15171b]">{p.text || '(no text layer on this page)'}</pre>
                    </div>
                  ))}
                </div>
              )}
              {tab === 'tables' && (
                <div className="h-full space-y-3 overflow-auto p-3">
                  {paper.pages?.every((p) => !p.tables.length) && <p className="text-xs text-neutral-500">No ruled tables detected. Tables without grid lines may not be detected; values in them can be entered manually in the review tab.</p>}
                  {paper.pages?.flatMap((p) => p.tables.map((t) => (
                    <div key={t.id}>
                      <div className="mb-1 text-[11px] font-semibold text-neutral-500">Table {t.id} · page {p.n} <button className="ml-1 text-rose-600 underline" onClick={() => goto(p.n, t.rows[0]?.[0])}>locate</button></div>
                      <table className="text-xs">
                        <tbody>{t.rows.map((r, i) => <tr key={i} className={i === 0 ? 'bg-neutral-100 font-semibold dark:bg-white/5' : 'border-t border-neutral-200 dark:border-white/10'}>{r.map((c, j) => <td key={j} className="border-x border-neutral-200 px-2 py-0.5 dark:border-white/10">{c}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  )))}
                </div>
              )}
              {tab === 'metadata' && <MetadataEditor paper={paper} libs={libs} onSave={saveMeta} />}
            </div>
          </Panel>
        ) : <Panel><p className="py-10 text-center text-sm text-neutral-500">Import a research paper PDF to begin. Try the synthetic test document to see the full extraction and review workflow.</p></Panel>}
      </div>
      {paper && tab !== 'review' && (
        <Inspector>
          <div className="space-y-1.5 text-xs">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Paper</div>
            <div className="font-semibold">{paper.metadata.title}</div>
            <div>{paper.metadata.authors?.join(', ')}</div>
            <div className="text-neutral-500">{paper.metadata.journal} {paper.metadata.year}</div>
            {paper.metadata.doi && <div>DOI: {paper.metadata.doi}</div>}
            <div>{paper.page_count} pages · {(paper.size_bytes ?? 0) / 1024 > 1024 ? `${((paper.size_bytes ?? 0) / 1048576).toFixed(1)} MB` : `${Math.round((paper.size_bytes ?? 0) / 1024)} kB`} · stored locally</div>
            <div>Metadata: {paper.metadata.verified ? <Badge tone="green">verified</Badge> : <Badge tone="amber">auto-detected — verify</Badge>}</div>
          </div>
        </Inspector>
      )}
    </div>
  )
}

function MetadataEditor({ paper, libs, onSave }: { paper: Paper; libs: Library[]; onSave: (m: PaperMeta, libs: string[]) => void }) {
  const [m, setM] = useState<PaperMeta>(paper.metadata)
  const [ls, setLs] = useState<string[]>(paper.library_ids)
  useEffect(() => { setM(paper.metadata); setLs(paper.library_ids) }, [paper])
  const det = paper.metadata.detection ?? {}
  return (
    <div className="grid max-w-3xl gap-2 p-3 text-xs">
      <Alert>Detected automatically: {Object.entries(det).filter(([, v]) => v).map(([k, v]) => `${k} (${v})`).join(', ') || 'nothing'}. Please verify against the document.</Alert>
      <Field label="Title"><Input className="w-full" value={m.title ?? ''} onChange={(e) => setM({ ...m, title: e.target.value })} /></Field>
      <Field label="Authors (semicolon separated)"><Input className="w-full" value={(m.authors ?? []).join('; ')} onChange={(e) => setM({ ...m, authors: e.target.value.split(';').map((s) => s.trim()).filter(Boolean) })} /></Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Journal" className="col-span-2"><Input className="w-full" value={m.journal ?? ''} onChange={(e) => setM({ ...m, journal: e.target.value })} /></Field>
        <Field label="Year"><Input className="w-full" value={m.year ?? ''} onChange={(e) => setM({ ...m, year: Number(e.target.value) || null })} /></Field>
      </div>
      <Field label="DOI"><Input className="w-full" value={m.doi ?? ''} onChange={(e) => setM({ ...m, doi: e.target.value })} /></Field>
      <div>
        <div className="mb-0.5 text-[11px] font-medium text-neutral-500">Associated libraries</div>
        <div className="flex flex-wrap gap-x-4">{libs.map((l) => <label key={l.id} className="flex items-center gap-1"><input type="checkbox" checked={ls.includes(l.id)} onChange={(e) => setLs(e.target.checked ? [...ls, l.id] : ls.filter((x) => x !== l.id))} />{l.name}</label>)}</div>
      </div>
      <div><Button variant="primary" onClick={() => onSave(m, ls)}>Save & mark verified</Button></div>
    </div>
  )
}
