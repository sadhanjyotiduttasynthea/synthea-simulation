import { ArrowRight, Atom, BookOpen, Boxes, CheckCircle2, Circle, Copy, Cuboid, FileCheck2, FlaskConical, LibraryBig, Play, RotateCcw, Sigma, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, PageHeader, Panel, Prov, Stat, cx } from '../components/ui'
import { api } from '../lib/api'
import { fmt } from '../lib/format'
import { useEvaluation } from '../lib/hooks'
import type { Project } from '../lib/types'
import { useActiveFormulation, useResults, useStore } from '../store'
import { emitCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'

interface Summary {
  libraries: number; materials: number; properties: { total: number; approved: number; reviewed: number; extracted: number }
  papers: number; extractions_pending: number; models: { total: number; approved: number; validated: number; extracted: number }
  geometry_objects: number; twins: number; studies: number; studies_with_validation: number; experiments: number
  recent: { kind: string; id: string; title: string; updated_at: string }[]
}

const RECENT_LINK: Record<string, (id: string) => string> = {
  paper: (id) => `/papers?paper=${id}`, model: (id) => `/models?model=${id}`, material: (id) => `/libraries?mat=${id}`,
  'digital twin': (id) => `/twin?twin=${id}`, study: () => '/twin?tab=results', library: (id) => `/libraries?lib=${id}`,
}

export default function Dashboard() {
  const { project, formulations, selectProject, refreshProjects, toast, init, setAssistant } = useStore()
  const active = useActiveFormulation()
  const results = useResults()
  const nav = useNavigate()
  const { result } = useEvaluation(active?.lines, project?.settings.serving_size_g ?? 30)
  const [s, setS] = useState<Summary | null>(null)
  useEffect(() => { if (project) api.get<Summary>(`/api/workspace/summary?project_id=${project.id}`).then(setS) }, [project])
  useEffect(() => { setAssistant('overview', { summary: s, result }) }, [s, result, setAssistant])
  if (!project) return null

  const pipeline = [
    { icon: BookOpen, label: 'Research papers', value: s?.papers, sub: `${s?.extractions_pending ?? 0} extractions to review`, to: '/papers' },
    { icon: FileCheck2, label: 'Property records', value: s?.properties.total, sub: `${s?.properties.approved ?? 0} approved · ${s?.properties.extracted ?? 0} unreviewed`, to: '/libraries' },
    { icon: LibraryBig, label: 'Scientific libraries', value: s?.libraries, sub: `${s?.materials ?? 0} materials (shared)`, to: '/libraries' },
    { icon: Sigma, label: 'Model registry', value: s?.models.total, sub: `${s?.models.approved ?? 0} approved for calculation`, to: '/models' },
    { icon: Boxes, label: 'Digital twins', value: s?.twins, sub: `${s?.geometry_objects ?? 0} geometry objects`, to: '/twin' },
    { icon: Play, label: 'Virtual experiments', value: s?.studies, sub: `${s?.studies_with_validation ?? 0} compared with data`, to: '/twin?tab=results' },
    { icon: FlaskConical, label: 'Experimental data', value: s?.experiments, sub: 'records in project', to: '/experiments' },
  ]
  const steps = [
    { done: (s?.libraries ?? 0) > 0, text: 'Explore the global scientific libraries and condition-aware records', to: '/libraries' },
    { done: (s?.papers ?? 0) > 0, text: 'Import a research PDF (try the bundled synthetic test document)', to: '/papers' },
    { done: (s?.properties.approved ?? 0) > 0, text: 'Review the extracted properties and equations with their source pages; approve them', to: '/papers' },
    { done: (s?.models.approved ?? 0) > 0, text: 'Approve a rheological / kinetic model in the Model Registry and check its validity range', to: '/models' },
    { done: (s?.geometry_objects ?? 0) > 0, text: 'Build or import a geometry and assign materials', to: '/geometry' },
    { done: (s?.studies ?? 0) > 0, text: 'Create a digital twin, configure physics, build the mesh and compute (F5)', to: '/twin' },
    { done: (s?.studies_with_validation ?? 0) > 0, text: 'Compare predictions with experimental data (residuals, RMSE)', to: '/twin?tab=results' },
    { done: false, text: 'Inspect molecular structures and the qualified interaction scenes', to: '/molecules' },
    { done: !!results.print, text: 'Generate and animate a 3D-printing toolpath', to: '/printing' },
    { done: false, text: 'Save the project (Ctrl+S) and export a report', to: '/reports' },
  ]

  const act = async (fn: () => Promise<void>, ok: string) => {
    try { await fn(); toast(ok, 'success'); refreshTree() } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-3">
      <PageHeader
        title={project.name}
        subtitle={project.description || 'Project workspace'}
        actions={<>
          <Button size="sm" onClick={() => emitCommand('file.new')}>New</Button>
          <Button size="sm" onClick={() => emitCommand('file.open')}>Open…</Button>
          <Button size="sm" onClick={() => emitCommand('file.save')}>Save</Button>
          <Button size="sm" onClick={() => act(async () => { const p = await api.post<Project>(`/api/projects/${project.id}/duplicate`); await refreshProjects(); await selectProject(p.id) }, 'Project duplicated')}><Copy className="h-3.5 w-3.5" />Duplicate</Button>
          {project.id === 'demo-pea-snack' ? (
            <Button size="sm" variant="ghost" onClick={() => confirm('Reset the demo project (formulations, experiments, flows)? Global libraries are not affected.') && act(async () => { await api.post('/api/admin/reset-demo'); await init() }, 'Demo project reset')}><RotateCcw className="h-3.5 w-3.5" />Reset demo</Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => confirm(`Delete project "${project.name}"?`) && act(async () => { await api.del(`/api/projects/${project.id}`); await refreshProjects(); const n = useStore.getState().projects[0]; if (n) await selectProject(n.id) }, 'Project deleted')}><Trash2 className="h-3.5 w-3.5" />Delete</Button>
          )}
        </>}
      />

      <Panel title="Knowledge → simulation pipeline" subtitle="Every simulation input traces back to an approved library record or model, and from there to its source page.">
        <div className="flex flex-wrap items-stretch gap-1.5">
          {pipeline.map((p, i) => (
            <div key={p.label} className="flex items-center gap-1.5">
              <button onClick={() => nav(p.to)} className="group w-[150px] rounded border border-neutral-200 bg-gradient-to-b from-white to-neutral-50 p-2.5 text-left transition hover:border-rose-500 dark:border-white/10 dark:from-[#1b1e23] dark:to-[#15171b]">
                <p.icon className="h-4 w-4 text-rose-600" />
                <div className="num mt-1 text-xl font-semibold">{p.value ?? '—'}</div>
                <div className="text-[11px] font-medium">{p.label}</div>
                <div className="text-[10px] text-neutral-500">{p.sub}</div>
              </button>
              {i < pipeline.length - 1 && <ArrowRight className="h-4 w-4 shrink-0 text-cyan-600" />}
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-3 @4xl:grid-cols-3">
        <Panel title="Demonstration walkthrough" className="@4xl:col-span-2">
          <ol className="space-y-0.5">
            {steps.map((st, i) => (
              <li key={i}>
                <Link to={st.to} className="group flex items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-neutral-50 dark:hover:bg-white/5">
                  {st.done ? <CheckCircle2 className="h-4 w-4 text-rose-600" /> : <Circle className="h-4 w-4 text-neutral-400" />}
                  <span className="w-5 text-xs text-neutral-400">{i + 1}.</span>
                  <span className="flex-1">{st.text}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-neutral-400 opacity-0 group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel title="Recent scientific activity" bodyClass="p-1.5">
          {!s?.recent.length && <p className="p-2 text-xs text-neutral-500">No activity yet.</p>}
          {s?.recent.map((r) => (
            <button key={r.kind + r.id} onClick={() => nav(RECENT_LINK[r.kind]?.(r.id) ?? '/')} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-50 dark:hover:bg-white/5">
              <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-neutral-400">{r.kind}</span>
              <span className="flex-1 truncate">{r.title}</span>
            </button>
          ))}
        </Panel>
      </div>

      <div className="grid gap-3 @4xl:grid-cols-3">
        <Panel title="Active formulation" className="@4xl:col-span-1" actions={<Button size="sm" onClick={() => nav('/formulation')}>Open studio</Button>}>
          <div className="mb-2 text-sm font-medium">{active?.name ?? '—'}</div>
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Protein" value={fmt(result?.composition.protein)} unit="%" prov="calculated" />
            <Stat label="Moisture" value={fmt(result?.composition.moisture)} unit="%" />
            <Stat label="Fat" value={fmt(result?.composition.fat)} unit="%" />
            <Stat label="ρ (25 °C)" value={fmt(result?.thermal?.density_kg_m3, 0)} unit="kg/m³" prov="predicted" />
          </div>
          <div className="mt-2 text-[11px] text-neutral-500">{formulations.length} formulation(s) in project</div>
        </Panel>
        <Panel title="Modelling workspaces" className="@4xl:col-span-1">
          <div className="grid grid-cols-2 gap-1.5">
            {[{ to: '/geometry', icon: Cuboid, t: 'Geometry' }, { to: '/twin', icon: Boxes, t: 'Digital twin' }, { to: '/molecules', icon: Atom, t: 'Molecules' }, { to: '/models', icon: Sigma, t: 'Equations' }].map((m) => (
              <button key={m.to} onClick={() => nav(m.to)} className="flex items-center gap-2 rounded border border-neutral-200 px-2 py-2 text-left text-xs hover:border-rose-500 dark:border-white/10"><m.icon className="h-4 w-4 text-cyan-600" />{m.t}</button>
            ))}
          </div>
        </Panel>
        <Panel title="Data provenance legend">
          <div className="space-y-1 text-[11px]">
            {[['measured', 'Experimentally measured'], ['literature', 'Published / reference data'], ['calculated', 'Exact engine calculation'], ['predicted', 'Model prediction with uncertainty'], ['illustrative', 'Placeholder / assumption'], ['synthetic', 'Generated demo data'], ['missing', 'Not available']].map(([k, t]) => (
              <div key={k} className={cx('flex items-center gap-2')}><Prov kind={k} className="w-20 justify-center" /><span className="text-neutral-600 dark:text-neutral-400">{t}</span></div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}
