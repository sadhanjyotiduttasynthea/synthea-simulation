import { Calculator, RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Field, Input, KV, NumInput, PageHeader, Panel, Tabs } from '../components/ui'
import { api } from '../lib/api'
import { fmt, fmtSci } from '../lib/format'
import { useStore } from '../store'

type Tab = 'general' | 'models' | 'equations' | 'ai' | 'data'
interface ModelDoc {
  id: string; name: string; equation: string; parameters: { symbol: string; description: string; unit: string }[]
  assumptions: string[]; applicability: string; validation: string; validation_description: string; reference?: string; computable: boolean; defaults?: Record<string, number>
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>('general')
  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <PageHeader title="Settings" subtitle="Project settings, scientific model registry, custom equations, AI assistant and data management." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'general', label: 'General' }, { id: 'models', label: 'Scientific model library' }, { id: 'equations', label: 'Custom equations' }, { id: 'ai', label: 'AI assistant' }, { id: 'data', label: 'Data' }]} />
      {tab === 'general' && <General />}
      {tab === 'models' && <Models />}
      {tab === 'equations' && <Equations />}
      {tab === 'ai' && <AI />}
      {tab === 'data' && <DataTab />}
    </div>
  )
}

function General() {
  const { project, saveProject, dark, setDark, toast } = useStore()
  const [p, setP] = useState(project!)
  useEffect(() => setP(project!), [project])
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Panel title="Project">
        <div className="space-y-2">
          <Field label="Name"><Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <Field label="Description"><Input value={p.description ?? ''} onChange={(e) => setP({ ...p, description: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Serving size [g]"><NumInput value={p.settings.serving_size_g} allowNull={false} onChange={(v) => setP({ ...p, settings: { ...p.settings, serving_size_g: v ?? 30 } })} /></Field>
            <Field label="Currency"><Input value={p.settings.currency} onChange={(e) => setP({ ...p, settings: { ...p.settings, currency: e.target.value } })} /></Field>
            <Field label="Electricity €/kWh"><NumInput value={p.settings.energy_price_eur_kwh} allowNull={false} onChange={(v) => setP({ ...p, settings: { ...p.settings, energy_price_eur_kwh: v ?? 0.2 } })} /></Field>
          </div>
          <Button variant="primary" onClick={() => saveProject(p).then(() => toast('Settings saved', 'success'))}><Save className="h-3.5 w-3.5" />Save</Button>
        </div>
      </Panel>
      <Panel title="Appearance">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />Dark mode</label>
      </Panel>
    </div>
  )
}

function Models() {
  const [models, setModels] = useState<ModelDoc[]>([])
  const [params, setParams] = useState<Record<string, Record<string, number>>>({})
  const [out, setOut] = useState<Record<string, Record<string, unknown> | string>>({})
  useEffect(() => {
    api.get<ModelDoc[]>('/api/models').then((m) => {
      setModels(m)
      setParams(Object.fromEntries(m.filter((x) => x.defaults).map((x) => [x.id, { ...x.defaults! }])))
    })
  }, [])
  const run = async (id: string) => {
    try {
      setOut({ ...out, [id]: await api.post<Record<string, unknown>>(`/api/models/${id}/compute`, params[id]) })
    } catch (e) {
      setOut({ ...out, [id]: (e as Error).message })
    }
  }
  const tone = (v: string) => (v === 'exact' ? 'green' : v === 'literature' ? 'neutral' : 'amber') as 'green' | 'neutral' | 'amber'
  return (
    <div className="space-y-3">
      {models.map((m) => (
        <Panel key={m.id} title={m.name} actions={<Badge tone={tone(m.validation)}>{m.validation}</Badge>}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="space-y-2 text-xs">
              <div className="rounded bg-neutral-50 px-2 py-1.5 font-mono text-[12px] dark:bg-neutral-800">{m.equation}</div>
              <table className="w-full"><thead><tr className="text-left text-[10px] uppercase text-neutral-500"><th>Symbol</th><th>Description</th><th>Unit</th></tr></thead>
                <tbody>{m.parameters.map((p) => <tr key={p.symbol} className="border-t border-neutral-100 dark:border-neutral-800"><td className="py-0.5 font-mono">{p.symbol}</td><td>{p.description}</td><td>{p.unit}</td></tr>)}</tbody></table>
              <div><b>Assumptions:</b> {m.assumptions.join('; ')}</div>
              <div><b>Applicability:</b> {m.applicability}</div>
              <div><b>Validation status:</b> {m.validation_description}</div>
              {m.reference && <div className="text-neutral-500"><b>Reference:</b> {m.reference}</div>}
            </div>
            {m.computable && params[m.id] ? (
              <div className="rounded border border-neutral-200 p-2 dark:border-neutral-700">
                <div className="mb-1 text-[10px] font-semibold uppercase text-neutral-500">Evaluate</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {Object.entries(params[m.id]).map(([k, v]) => <Field key={k} label={k}><NumInput value={v} allowNull={false} onChange={(nv) => setParams({ ...params, [m.id]: { ...params[m.id], [k]: nv ?? 0 } })} /></Field>)}
                </div>
                <Button size="sm" className="mt-2" onClick={() => run(m.id)}><Calculator className="h-3.5 w-3.5" />Compute</Button>
                {out[m.id] && (typeof out[m.id] === 'string' ? <div className="mt-2"><Alert kind="error">{out[m.id] as string}</Alert></div> : (
                  <div className="mt-2"><KV rows={Object.entries(out[m.id] as Record<string, unknown>).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => [k, typeof v === 'number' ? fmtSci(v, 4) : String(v)])} /></div>
                ))}
              </div>
            ) : <div className="text-xs text-neutral-500">Evaluated inside the formulation engine.</div>}
          </div>
        </Panel>
      ))}
    </div>
  )
}

function Equations() {
  const [expr, setExpr] = useState('tau_y + K * gamma ** n')
  const [vars, setVars] = useState<Record<string, number>>({ tau_y: 50, K: 30, gamma: 10, n: 0.4 })
  const [res, setRes] = useState<{ ok: boolean; value?: number; error?: string; variables?: string[] } | null>(null)
  const evaluate = async () => {
    const r = await api.post<typeof res>('/api/expressions/evaluate', { expression: expr, variables: vars })
    setRes(r)
    if (r?.variables) setVars((v) => Object.fromEntries(r.variables!.map((k) => [k, v[k] ?? 0])))
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Panel title="User-defined equation">
        <div className="space-y-2">
          <Field label="Expression" hint="Allowed: + − × ÷ ** %, parentheses, sqrt exp log log10 sin cos tan tanh abs min max pow, constants pi e. No code execution."><Input className="w-full font-mono" value={expr} onChange={(e) => setExpr(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(vars).map(([k, v]) => <Field key={k} label={k}><NumInput value={v} allowNull={false} onChange={(nv) => setVars({ ...vars, [k]: nv ?? 0 })} /></Field>)}
          </div>
          <Button variant="primary" onClick={evaluate}><Calculator className="h-3.5 w-3.5" />Evaluate</Button>
          {res && (res.ok ? <div className="text-sm">Result: <b className="num">{fmtSci(res.value, 6)}</b> <Badge tone="amber">user-defined · unvalidated</Badge></div> : <Alert kind="error">{res.error}</Alert>)}
        </div>
      </Panel>
      <Panel title="Safety">
        <p className="text-xs text-neutral-600 dark:text-neutral-400">Expressions are parsed into an abstract syntax tree on the server and evaluated by a whitelist interpreter. Attribute access, indexing, function definitions, imports and any call outside the listed mathematical functions are rejected, so user equations cannot execute arbitrary code. Results of user-defined equations are labelled unvalidated.</p>
        <p className="mt-2 text-xs">Example: Herschel–Bulkley stress at γ̇ = 10 s⁻¹ with τ₀ = 50 Pa, K = 30 Pa·sⁿ, n = 0.4 → {fmt(50 + 30 * 10 ** 0.4, 2)} Pa.</p>
      </Panel>
    </div>
  )
}

function AI() {
  const [s, setS] = useState<{ llm_available: boolean; model: string | null; mode: string; note: string } | null>(null)
  useEffect(() => { api.get<typeof s>('/api/assistant/status').then(setS) }, [])
  return (
    <Panel title="AI assistant configuration">
      {s && (
        <div className="space-y-2 text-xs">
          <div>Mode: <Badge tone={s.llm_available ? 'green' : 'neutral'}>{s.llm_available ? `Claude (${s.model})` : 'Built-in deterministic explainer'}</Badge></div>
          <p>{s.note}</p>
          <p>To enable the optional Claude integration, set the environment variable <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">ANTHROPIC_API_KEY</code> on the <b>server</b> before starting the backend. The key is never sent to the browser. Optionally set <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">SYNTHEA_AI_MODEL</code>.</p>
          <Alert>The assistant receives only the engine's computed results as context and is instructed never to produce numbers that are not in that context. The platform is fully functional without any external AI service.</Alert>
        </div>
      )}
    </Panel>
  )
}

function DataTab() {
  const { init, toast } = useStore()
  return (
    <Panel title="Data management">
      <div className="space-y-2 text-xs">
        <p>Data are stored in a local SQLite database on the server (<code>backend/data/synthea.db</code>). The repository layer is document-oriented and can be ported to PostgreSQL (JSONB).</p>
        <Button variant="danger" onClick={() => confirm('Reset the demo project (formulations, experiments, process flows) and re-seed the six demo ingredients?') && api.post('/api/admin/reset-demo').then(() => init()).then(() => toast('Demo data reset', 'success'))}><RotateCcw className="h-3.5 w-3.5" />Reset demo data</Button>
        <Button onClick={() => { localStorage.removeItem('synthea-ui'); location.reload() }}>Clear cached results in this browser</Button>
      </div>
    </Panel>
  )
}
