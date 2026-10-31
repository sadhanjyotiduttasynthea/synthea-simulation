import { ArrowRight, Beaker, CheckCircle2, Circle, Copy, Download, Factory, FileText, FlaskConical, Library, Plus, Printer, RotateCcw, Sparkles, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, Field, Input, Modal, PageHeader, Panel, Prov, Stat } from '../components/ui'
import { api, download, readFile } from '../lib/api'
import { eur, fmt, pct } from '../lib/format'
import { useEvaluation } from '../lib/hooks'
import type { Project } from '../lib/types'
import { useActiveFormulation, useResults, useStore } from '../store'

const MODULES = [
  { to: '/materials', icon: Library, title: 'Synthea Materials', text: 'Scientific ingredient library with provenance labels and a virtual formulation laboratory.' },
  { to: '/optimizer', icon: Sparkles, title: 'Synthea Optimize', text: 'Linear-programming optimiser, Pareto front, infeasibility diagnosis and GP-based processing optimisation.' },
  { to: '/process', icon: Factory, title: 'Synthea Process', text: 'Drag-and-drop pilot line with mass and energy balances, residence times and operating cost.' },
  { to: '/printing', icon: Printer, title: 'Synthea Print', text: 'Virtual 3D food printer with real toolpath generation and extrusion calculations.' },
]

export default function Dashboard() {
  const { project, projects, ingredients, formulations, selectProject, refreshProjects, toast, init, setAssistant } = useStore()
  const active = useActiveFormulation()
  const results = useResults()
  const nav = useNavigate()
  const { result } = useEvaluation(active?.lines, project?.settings.serving_size_g ?? 30)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setAssistant('dashboard', { result, project: project?.name })
  }, [result, project?.name, setAssistant])

  if (!project) return null

  const steps = [
    { done: ingredients.length >= 6, text: 'Inspect the six ingredients and their data provenance', to: '/materials' },
    { done: formulations.length > 0, text: 'Edit the baseline formulation; nutrition and cost update immediately', to: '/formulation' },
    { done: !!results.optimization, text: 'Set protein ≥ 15 % and cost ≤ €2.20/kg, run the optimiser, compare candidates', to: '/optimizer' },
    { done: !!results.scenario, text: 'Explore the editable experimental savings scenario', to: '/experiments' },
    { done: !!results.process, text: 'Transfer a formulation to the process simulator and run it', to: '/process' },
    { done: !!results.print, text: 'Transfer to the 3D printing lab and animate the toolpath', to: '/printing' },
    { done: false, text: 'Export a PDF / JSON / CSV report', to: '/reports' },
  ]

  const createProject = async () => {
    setBusy(true)
    try {
      const p = await api.post<Project>('/api/projects', { name: newName || 'Untitled project', description: '' })
      await refreshProjects()
      await selectProject(p.id)
      setNewOpen(false)
      setNewName('')
      toast('Project created', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<void>, ok: string) => {
    try {
      await fn()
      toast(ok, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title={project.name}
        subtitle={project.description || 'Project workspace'}
        actions={
          <>
            <Button size="sm" onClick={() => setNewOpen(true)}><Plus className="h-3.5 w-3.5" />New project</Button>
            <Button size="sm" onClick={() => act(async () => {
              const p = await api.post<Project>(`/api/projects/${project.id}/duplicate`)
              await refreshProjects()
              await selectProject(p.id)
            }, 'Project duplicated')}><Copy className="h-3.5 w-3.5" />Duplicate</Button>
            <Button size="sm" onClick={() => act(async () => {
              const b = await api.get<unknown>(`/api/projects/${project.id}/export`)
              download(`${project.name.replace(/\W+/g, '_')}.synthea.json`, JSON.stringify(b, null, 2))
            }, 'Project exported')}><Download className="h-3.5 w-3.5" />Save to file</Button>
            <Button size="sm" onClick={() => act(async () => {
              const txt = await readFile('.json')
              const p = await api.post<Project>('/api/projects/import', JSON.parse(txt))
              await refreshProjects()
              await selectProject(p.id)
            }, 'Project loaded')}><Upload className="h-3.5 w-3.5" />Load from file</Button>
            {project.id === 'demo-pea-snack' ? (
              <Button size="sm" variant="ghost" onClick={() => confirm('Reset the demo project to its original state? Formulations, experiments and flows of the demo project will be replaced.') && act(async () => {
                await api.post('/api/admin/reset-demo')
                await init()
              }, 'Demo project reset')}><RotateCcw className="h-3.5 w-3.5" />Reset demo</Button>
            ) : (
              <Button size="sm" variant="danger" onClick={() => confirm(`Delete project "${project.name}" and all its data?`) && act(async () => {
                await api.del(`/api/projects/${project.id}`)
                await refreshProjects()
                const next = useStore.getState().projects[0]
                if (next) await selectProject(next.id)
              }, 'Project deleted')}><Trash2 className="h-3.5 w-3.5" />Delete</Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2 @@5xl:grid-cols-3 @5xl:grid-cols-6">
        <Stat label="Active formulation" value={<span className="text-sm">{active?.name ?? '—'}</span>} sub={`${formulations.length} formulation(s)`} />
        <Stat label="Protein" value={fmt(result?.composition.protein)} unit="%" prov="calculated" />
        <Stat label="Raw-material cost" value={eur(result?.cost_per_kg, 3)} unit="/kg" prov="calculated" sub="from illustrative prices" />
        <Stat label="Cost / serving" value={eur(result?.cost_per_serving, 3)} sub={`${project.settings.serving_size_g} g serving`} />
        <Stat label="Energy" value={fmt(result?.energy_kcal_100g, 0)} unit="kcal/100 g" />
        <Stat label="Projects" value={projects.length} sub={`${ingredients.length} ingredients in library`} />
      </div>

      <div className="grid gap-4 @3xl:grid-cols-3">
        <Panel title="Hackathon demonstration walkthrough" className="@3xl:col-span-2">
          <ol className="space-y-1">
            {steps.map((s, i) => (
              <li key={i}>
                <Link to={s.to} className="group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800">
                  {s.done ? <CheckCircle2 className="h-4 w-4 text-accent" /> : <Circle className="h-4 w-4 text-neutral-400" />}
                  <span className="w-5 text-xs text-neutral-400">{i + 1}.</span>
                  <span className="flex-1">{s.text}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-neutral-400 opacity-0 group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel title="Data integrity legend">
          <div className="space-y-1.5 text-xs">
            {[
              ['measured', 'Experimentally measured in your lab'],
              ['literature', 'Published or standard reference data'],
              ['calculated', 'Exact calculation by the engine (mass/energy balance)'],
              ['predicted', 'Model prediction with uncertainty'],
              ['illustrative', 'Placeholder or assumption for demonstration'],
              ['synthetic', 'Generated demo data, not a measurement'],
              ['missing', 'Data not available; prediction not supported'],
            ].map(([k, t]) => (
              <div key={k} className="flex items-center gap-2"><Prov kind={k} className="w-20 justify-center" /><span className="text-neutral-600 dark:text-neutral-400">{t}</span></div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-3 @@5xl:grid-cols-2 @5xl:grid-cols-4">
        {MODULES.map(({ to, icon: Icon, title, text }) => (
          <button key={to} onClick={() => nav(to)} className="group rounded border border-neutral-200 bg-white p-4 text-left transition hover:border-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-400">
            <Icon className="h-5 w-5 text-accent" />
            <div className="mt-2 text-sm font-semibold">{title}</div>
            <p className="mt-1 text-xs text-neutral-500">{text}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <Panel title="Formulations in this project" actions={<Button size="sm" onClick={() => nav('/formulation')}><Beaker className="h-3.5 w-3.5" />Open studio</Button>}>
          {formulations.length === 0 ? <p className="text-xs text-neutral-500">No formulations yet.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-neutral-500"><th className="py-1">Name</th><th>Origin</th><th className="text-right">Ingredients</th></tr></thead>
              <tbody>
                {formulations.map((f) => (
                  <tr key={f.id} className="border-t border-neutral-100 dark:border-neutral-800">
                    <td className="py-1">{f.name}{f.id === active?.id && <span className="ml-1 text-accent">●</span>}</td>
                    <td className="text-neutral-500">{f.origin ?? 'manual'}</td>
                    <td className="text-right">{f.lines.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Problem context">
          <div className="space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <p>Six ingredients with ten concentration levels each span 10<sup>6</sup> unconstrained theoretical combinations; processing parameters multiply this further. These figures illustrate combinatorial complexity, not the number of experiments actually run.</p>
            <p>Synthea evaluates formulations virtually, optimises them mathematically and selects the most informative physical experiments — it supports, but does not replace, laboratory validation.</p>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => nav('/experiments')}><FlaskConical className="h-3.5 w-3.5" />Experiments</Button>
              <Button size="sm" onClick={() => nav('/reports')}><FileText className="h-3.5 w-3.5" />Reports</Button>
            </div>
          </div>
        </Panel>
      </div>
      {result?.missing_data && result.missing_data.length > 0 && <Alert kind="warn" title="Missing data in active formulation">{result.missing_data.join('; ')}</Alert>}
      <p className="text-[10px] text-neutral-400">Protein shown: {pct(result?.composition.protein)} — computed by linear mass balance from library values.</p>

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New project" footer={<><Button onClick={() => setNewOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={createProject}>Create</Button></>}>
        <Field label="Project name"><Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Faba bean spread" /></Field>
      </Modal>
    </div>
  )
}
