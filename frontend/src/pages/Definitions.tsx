import { Plus, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Alert, Button, Input, PageHeader, Panel, Prov } from '../components/ui'
import { api } from '../lib/api'
import { fmtSci } from '../lib/format'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { Inspector, useEquations } from '../workspace/Slots'

interface Param { name: string; expression: string; unit: string; description: string }
interface Const { name: string; value: number; unit: string; description: string; source: string }

export default function Definitions() {
  const { project, saveProject, toast } = useStore()
  const [params, setParams] = useState<Param[]>(() => ((project as unknown as { parameters?: Param[] })?.parameters ?? []))
  const [vals, setVals] = useState<{ name: string; value: number | null; error: string | null }[]>([])
  const [consts, setConsts] = useState<Const[]>([])
  useEffect(() => { api.get<Const[]>('/api/definitions/constants').then(setConsts) }, [])
  useEffect(() => {
    const t = setTimeout(() => api.post<typeof vals>('/api/definitions/evaluate', { parameters: params }).then(setVals), 200)
    return () => clearTimeout(t)
  }, [params])
  useEquations([{ title: 'Arrhenius temperature dependence (template)', latex: 'k(T) = A\\,\\exp\\!\\left(-\\frac{E_a}{R\\,T}\\right)', note: 'R is available as a global constant.' }], [])
  const add = () => setParams([...params, { name: `p${params.length + 1}`, expression: '0', unit: '', description: '' }])
  useCommand('definitions.add', add)
  const set = (i: number, k: keyof Param, v: string) => setParams(params.map((p, j) => (j === i ? { ...p, [k]: v } : p)))
  const save = async () => {
    await saveProject({ ...project!, parameters: params } as typeof project & { parameters: Param[] })
    toast('Global definitions saved', 'success')
  }
  return (
    <div className="max-w-5xl space-y-3">
      <PageHeader title="Global Definitions" subtitle="Project parameters (evaluated in order with the safe expression parser) and physical constants." actions={<><Button size="sm" onClick={add}><Plus className="h-3.5 w-3.5" />Parameter</Button><Button size="sm" variant="primary" onClick={save}><Save className="h-3.5 w-3.5" />Save</Button></>} />
      <Panel title="Parameters" bodyClass="p-0">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 text-left text-[10px] uppercase text-neutral-500 dark:bg-neutral-900"><tr><th className="px-2 py-1">Name</th><th>Expression</th><th>Unit</th><th className="text-right">Value</th><th className="px-2">Description</th><th></th></tr></thead>
          <tbody>
            {params.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-neutral-500">No parameters. Add parameters such as process temperature or concentration and reference them in other expressions.</td></tr>}
            {params.map((p, i) => (
              <tr key={i} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="w-32 p-1"><Input className="w-full font-mono" value={p.name} onChange={(e) => set(i, 'name', e.target.value)} /></td>
                <td className="p-1"><Input className="w-full font-mono" value={p.expression} onChange={(e) => set(i, 'expression', e.target.value)} /></td>
                <td className="w-24 p-1"><Input className="w-full" value={p.unit} onChange={(e) => set(i, 'unit', e.target.value)} /></td>
                <td className="num w-32 p-1 text-right">{vals[i]?.error ? <span className="text-red-600" title={vals[i].error!}>error</span> : fmtSci(vals[i]?.value ?? null, 5)}</td>
                <td className="p-1"><Input className="w-full" value={p.description} onChange={(e) => set(i, 'description', e.target.value)} /></td>
                <td className="w-8 text-center"><button onClick={() => setParams(params.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {vals.some((v) => v.error) && <Alert kind="warn">{vals.filter((v) => v.error).map((v) => `${v.name}: ${v.error}`).join('; ')}</Alert>}
      <Panel title="Physical constants" bodyClass="p-0">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 text-left text-[10px] uppercase text-neutral-500 dark:bg-neutral-900"><tr><th className="px-2 py-1">Symbol</th><th className="text-right">Value</th><th className="px-2">Unit</th><th>Description</th><th>Source</th></tr></thead>
          <tbody>{consts.map((c) => <tr key={c.name} className="border-t border-neutral-100 dark:border-neutral-800"><td className="px-2 py-1 font-mono">{c.name}</td><td className="num text-right">{fmtSci(c.value, 10)}</td><td className="px-2">{c.unit}</td><td>{c.description}</td><td className="text-neutral-500">{c.source}</td></tr>)}</tbody>
        </table>
      </Panel>
      <Inspector>
        <div className="space-y-2 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Global definitions</div>
          <p>Parameters are evaluated top to bottom. Each expression may use constants and earlier parameters; only arithmetic and whitelisted functions are allowed.</p>
          <div className="flex items-center gap-1">Values: <Prov kind="calculated" /></div>
        </div>
      </Inspector>
    </div>
  )
}
