import { AlertTriangle, Bot, ChartLine, Database, FileText, Sigma, SquareTerminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Assistant } from '../components/Assistant'
import { Equation } from '../components/Equation'
import { cx } from '../components/ui'
import { api } from '../lib/api'
import { fmt } from '../lib/format'
import type { Experiment } from '../lib/types'
import { useStore } from '../store'
import { useWs, type BottomTab } from './wsStore'

const TABS: { id: BottomTab; label: string; icon: typeof Bot }[] = [
  { id: 'results', label: 'Results', icon: FileText },
  { id: 'plots', label: 'Plots', icon: ChartLine },
  { id: 'equations', label: 'Equations', icon: Sigma },
  { id: 'log', label: 'Solver Log', icon: SquareTerminal },
  { id: 'warnings', label: 'Warnings', icon: AlertTriangle },
  { id: 'assistant', label: 'AI Assistant', icon: Bot },
  { id: 'data', label: 'Experimental Data', icon: Database },
]

export function BottomPanel() {
  const { bottomTab, setBottomTab, log, clearLog, equations, setSlots } = useWs()
  const warnings = log.filter((l) => l.level === 'warn' || l.level === 'error')
  const resultsRef = useCallback((el: HTMLDivElement | null) => { if (el) setSlots({ resultsEl: el }) }, [setSlots])
  const plotsRef = useCallback((el: HTMLDivElement | null) => { if (el) setSlots({ plotsEl: el }) }, [setSlots])
  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-[#15171b]">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-neutral-200 bg-neutral-100 px-1 dark:border-white/10 dark:bg-[#1b1e23]">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setBottomTab(t.id)}
            className={cx('flex items-center gap-1.5 border-b-2 px-2.5 py-1 text-[11.5px]', bottomTab === t.id ? 'border-rose-600 text-neutral-900 dark:text-white' : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200')}>
            <t.icon className="h-3.5 w-3.5" />{t.label}
            {t.id === 'warnings' && warnings.length > 0 && <span className="rounded bg-amber-500 px-1 text-[9px] text-white">{warnings.length}</span>}
            {t.id === 'equations' && equations.length > 0 && <span className="rounded bg-cyan-600 px-1 text-[9px] text-white">{equations.length}</span>}
          </button>
        ))}
        <div className="flex-1" />
        {(bottomTab === 'log' || bottomTab === 'warnings') && <button onClick={clearLog} className="p-1 text-neutral-400 hover:text-rose-600" title="Clear log"><Trash2 className="h-3.5 w-3.5" /></button>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto">
        <div ref={resultsRef} className={cx('h-full p-2', bottomTab !== 'results' && 'hidden')} />
        <div ref={plotsRef} className={cx('h-full p-2', bottomTab !== 'plots' && 'hidden')} />
        {bottomTab === 'results' && <SlotHint text="Run a study, optimisation or calculation to see numerical results here." />}
        {bottomTab === 'plots' && <SlotHint text="Plots produced by the active view appear here." />}
        {bottomTab === 'equations' && (
          <div className="grid gap-2 p-2 md:grid-cols-2">
            {equations.length === 0 && <p className="text-xs text-neutral-500">The active view has no equations. Open the model registry, a digital twin or the molecular viewer.</p>}
            {equations.map((e, i) => (
              <div key={i} className="rounded border border-neutral-200 p-2 dark:border-white/10">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-neutral-600 dark:text-neutral-300">{e.title}{e.status && <span className="rounded bg-cyan-50 px-1 text-[9.5px] font-medium uppercase text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300">{e.status}</span>}</div>
                <div className="overflow-x-auto py-1"><Equation latex={e.latex} display /></div>
                {e.note && <div className="text-[10.5px] text-neutral-500">{e.note}</div>}
              </div>
            ))}
          </div>
        )}
        {(bottomTab === 'log' || bottomTab === 'warnings') && (
          <div className="font-mono text-[11px] leading-[1.55]">
            {(bottomTab === 'log' ? log : warnings).length === 0 && <div className="p-2 text-neutral-500">No messages.</div>}
            {(bottomTab === 'log' ? log : warnings).slice().reverse().map((l) => (
              <div key={l.id} className="flex gap-2 border-b border-neutral-100 px-2 dark:border-white/5">
                <span className="text-neutral-400">{l.t}</span>
                <span className={cx('w-12 shrink-0 uppercase', l.level === 'error' ? 'text-red-600' : l.level === 'warn' ? 'text-amber-600' : l.level === 'success' ? 'text-emerald-600' : 'text-cyan-600')}>{l.level}</span>
                <span className="w-24 shrink-0 truncate text-neutral-500">{l.source}</span>
                <span className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">{l.message}</span>
              </div>
            ))}
          </div>
        )}
        {bottomTab === 'assistant' && <Assistant embedded />}
        {bottomTab === 'data' && <ExperimentalData />}
      </div>
    </div>
  )
}

function SlotHint({ text }: { text: string }) {
  const el = useWs((s) => s.bottomTab === 'results' ? s.resultsEl : s.plotsEl)
  const [empty, setEmpty] = useState(true)
  useEffect(() => {
    if (!el) return
    const check = () => setEmpty(el.childElementCount === 0)
    check()
    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true })
    return () => mo.disconnect()
  }, [el])
  return empty ? <p className="pointer-events-none absolute left-3 top-2 text-xs text-neutral-500">{text}</p> : null
}

function ExperimentalData() {
  const project = useStore((s) => s.project)
  const [rows, setRows] = useState<Experiment[]>([])
  useEffect(() => {
    if (project) api.get<Experiment[]>(`/api/experiments?project_id=${project.id}`).then(setRows).catch(() => setRows([]))
  }, [project])
  if (!rows.length) return <p className="p-2 text-xs text-neutral-500">No experimental records in this project. Add them under Study → Experiments & DoE.</p>
  return (
    <table className="w-full whitespace-nowrap text-[11px]">
      <thead className="sticky top-0 bg-neutral-50 text-left text-neutral-500 dark:bg-[#1b1e23]"><tr><th className="px-2">Name</th><th>Type</th><th className="text-right">T °C</th><th className="text-right">η Pa·s</th><th className="text-right">Hardness N</th><th className="text-right">Shape %</th><th className="px-2">Notes</th></tr></thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id} className="border-t border-neutral-100 dark:border-white/5">
            <td className="px-2">{e.name}</td><td>{e.data_type}</td>
            <td className="text-right">{fmt(e.process.temperature_c as number, 0)}</td><td className="text-right">{fmt(e.measurements.viscosity_pa_s as number, 2)}</td>
            <td className="text-right">{fmt(e.measurements.hardness_n as number, 1)}</td><td className="text-right">{fmt(e.measurements.shape_retention_pct as number, 1)}</td>
            <td className="max-w-[300px] truncate px-2 text-neutral-500">{e.notes}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
