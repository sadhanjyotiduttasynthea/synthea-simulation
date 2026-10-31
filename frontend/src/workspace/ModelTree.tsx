import {
  Atom, Beaker, BookOpen, Boxes, ChevronDown, ChevronRight, Cuboid, FlaskConical, FolderTree, Globe2, Grid3x3, LibraryBig, LineChart, Network,
  Play, Printer, Sigma, Sparkles, Thermometer, type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cx } from '../components/ui'
import { api } from '../lib/api'
import { useStore } from '../store'
import { emitCommand } from './commands'
import { useWs } from './wsStore'

interface Action { label: string; to?: string; cmd?: string; payload?: unknown }
interface Node { id: string; label: string; icon?: LucideIcon; to?: string; children?: Node[]; actions?: Action[]; badge?: string }

export interface TreeIndex {
  libraries: { id: string; name: string; materials: number }[]
  papers: { id: string; title: string; pending: number }[]
  models: { approved: number; total: number }
  geometry: { id: string; name: string; kind: string }[]
  twins: { id: string; name: string; physics: string[] }[]
}

export const refreshTree = () => window.dispatchEvent(new Event('synthea:refresh-tree'))

export function ModelTree() {
  const { project, formulations } = useStore()
  const nav = useNavigate()
  const loc = useLocation()
  const [idx, setIdx] = useState<TreeIndex | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('synthea-tree-open') ?? '{"project":true,"libs":true,"components":true,"geometry":true,"physics":true,"study":true,"results":true}'))
  const [menu, setMenu] = useState<{ x: number; y: number; actions: Action[] } | null>(null)
  const select = useWs((s) => s.select)

  const load = useCallback(() => {
    if (!project) return
    api.get<TreeIndex>(`/api/workspace/tree?project_id=${project.id}`).then(setIdx).catch(() => setIdx(null))
  }, [project])
  useEffect(() => {
    load()
    window.addEventListener('synthea:refresh-tree', load)
    return () => window.removeEventListener('synthea:refresh-tree', load)
  }, [load])
  useEffect(() => {
    localStorage.setItem('synthea-tree-open', JSON.stringify(open))
  }, [open])
  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const tree: Node = {
    id: 'project', label: project?.name ?? 'Project', icon: FolderTree, to: '/',
    actions: [{ label: 'Save project', cmd: 'file.save' }, { label: 'Save as…', cmd: 'file.saveAs' }, { label: 'Project settings', to: '/settings' }],
    children: [
      { id: 'defs', label: 'Global Definitions', icon: Sigma, to: '/definitions', actions: [{ label: 'Add parameter', to: '/definitions', cmd: 'definitions.add' }] },
      {
        id: 'libs', label: 'Scientific Libraries', icon: LibraryBig, to: '/libraries',
        actions: [{ label: 'New library', to: '/libraries', cmd: 'library.new' }, { label: 'Import library file', to: '/libraries', cmd: 'library.import' }],
        children: [
          ...(idx?.libraries ?? []).map((l) => ({ id: `lib:${l.id}`, label: l.name, icon: LibraryBig, to: `/libraries?lib=${l.id}`, badge: String(l.materials), actions: [{ label: 'Open', to: `/libraries?lib=${l.id}` }, { label: 'New material', to: `/libraries?lib=${l.id}`, cmd: 'material.new' }] })),
          { id: 'papers', label: 'Research Papers', icon: BookOpen, to: '/papers', badge: idx ? String(idx.papers.length) : undefined, actions: [{ label: 'Import PDF…', to: '/papers', cmd: 'paper.import' }],
            children: (idx?.papers ?? []).map((p) => ({ id: `paper:${p.id}`, label: p.title, icon: BookOpen, to: `/papers?paper=${p.id}`, badge: p.pending ? `${p.pending} to review` : undefined })) },
          { id: 'models', label: 'Model Registry', icon: Sigma, to: '/models', badge: idx ? `${idx.models.approved}/${idx.models.total}` : undefined, actions: [{ label: 'New model', to: '/models', cmd: 'model.new' }] },
        ],
      },
      {
        id: 'components', label: 'Components', icon: Boxes,
        children: [
          { id: 'forms', label: 'Formulations', icon: Beaker, to: '/formulation', badge: String(formulations.length), actions: [{ label: 'Open studio', to: '/formulation' }],
            children: formulations.map((f) => ({ id: `form:${f.id}`, label: f.name, icon: Beaker, to: '/formulation' })) },
          { id: 'twins', label: 'Digital Twins', icon: Boxes, to: '/twin', actions: [{ label: 'New digital twin', to: '/twin', cmd: 'twin.new' }],
            children: (idx?.twins ?? []).map((t) => ({ id: `twin:${t.id}`, label: t.name, icon: Boxes, to: `/twin?twin=${t.id}` })) },
        ],
      },
      { id: 'geometry', label: 'Geometry', icon: Cuboid, to: '/geometry',
        actions: ['cuboid', 'cylinder', 'sphere', 'rectangle', 'circle'].map((k) => ({ label: `Add ${k}`, to: '/geometry', cmd: 'geometry.add', payload: k })),
        children: (idx?.geometry ?? []).map((g) => ({ id: `geo:${g.id}`, label: g.name, icon: Cuboid, to: `/geometry?sel=${g.id}`, badge: g.kind })) },
      { id: 'materials', label: 'Materials', icon: Globe2,
        children: [
          { id: 'ingredients', label: 'Ingredient table', icon: Beaker, to: '/materials' },
          { id: 'molecules', label: 'Molecular structures', icon: Atom, to: '/molecules' },
        ] },
      { id: 'physics', label: 'Physics', icon: Thermometer, to: '/twin?tab=physics',
        actions: [['heat', 'Heat transfer'], ['flow', 'Laminar flow'], ['diffusion', 'Diffusion'], ['kinetics', 'Reaction kinetics']].map(([k, l]) => ({ label: `Add ${l}`, to: '/twin?tab=physics', cmd: 'twin.addPhysics', payload: k })),
        children: [
          { id: 'process', label: 'Process line (flowsheet)', icon: Network, to: '/process' },
          { id: 'printing', label: '3D food printing', icon: Printer, to: '/printing' },
        ] },
      { id: 'mesh', label: 'Mesh', icon: Grid3x3, to: '/twin?tab=mesh', actions: [{ label: 'Build mesh', to: '/twin?tab=mesh', cmd: 'mesh.build' }] },
      { id: 'study', label: 'Study', icon: Play, to: '/twin?tab=study', actions: [{ label: 'Compute (F5)', to: '/twin?tab=study', cmd: 'study.compute' }],
        children: [
          { id: 'opt', label: 'Formulation optimisation', icon: Sparkles, to: '/optimizer' },
          { id: 'exp', label: 'Experiments & DoE', icon: FlaskConical, to: '/experiments' },
        ] },
      { id: 'results', label: 'Results', icon: LineChart, to: '/twin?tab=results', actions: [{ label: 'Export results', to: '/twin?tab=results', cmd: 'results.export' }, { label: 'Generate report', to: '/reports' }],
        children: [{ id: 'reports', label: 'Reports', icon: LineChart, to: '/reports' }] },
    ],
  }

  const here = loc.pathname + loc.search
  const run = (a: Action) => {
    if (a.to) nav(a.to)
    if (a.cmd) emitCommand(a.cmd, a.payload)
    setMenu(null)
  }

  const render = (n: Node, depth: number) => {
    const hasKids = !!n.children?.length
    const isOpen = open[n.id] ?? depth < 1
    const active = n.to && (n.to === here || (n.to === loc.pathname && !loc.search && !n.to.includes('?')))
    const Icon = n.icon
    return (
      <div key={n.id}>
        <div
          className={cx('group flex h-[22px] cursor-default items-center gap-1 rounded-sm pr-1 text-[12px]', active ? 'bg-rose-600/90 text-white' : 'hover:bg-neutral-200/70 dark:hover:bg-white/5')}
          style={{ paddingLeft: depth * 12 + 2 }}
          onClick={() => {
            if (n.to) nav(n.to)
            select({ kind: n.id.split(':')[0], id: n.id.split(':')[1], label: n.label })
          }}
          onDoubleClick={() => hasKids && setOpen({ ...open, [n.id]: !isOpen })}
          onContextMenu={(e: MouseEvent) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, actions: [...(n.to ? [{ label: 'Open', to: n.to }] : []), ...(n.actions ?? [])] })
          }}
        >
          <button className="flex h-4 w-4 items-center justify-center text-neutral-400" onClick={(e) => { e.stopPropagation(); if (hasKids) setOpen({ ...open, [n.id]: !isOpen }) }}>
            {hasKids ? (isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : null}
          </button>
          {Icon && <Icon className={cx('h-3.5 w-3.5 shrink-0', active ? 'text-white' : 'text-rose-600 dark:text-rose-400')} strokeWidth={1.7} />}
          <span className="truncate">{n.label}</span>
          {n.badge && <span className={cx('ml-auto shrink-0 rounded px-1 text-[9.5px]', active ? 'bg-white/20' : 'bg-neutral-200 text-neutral-600 dark:bg-white/10 dark:text-neutral-400')}>{n.badge}</span>}
        </div>
        {hasKids && isOpen && n.children!.map((c) => render(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-auto px-1 py-1 font-[450]">
      {render(tree, 0)}
      {menu && (
        <div className="fixed z-[80] min-w-44 rounded border border-neutral-300 bg-white py-1 text-[12px] shadow-xl dark:border-neutral-700 dark:bg-neutral-900" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.actions.length === 0 && <div className="px-3 py-1 text-neutral-400">No actions</div>}
          {menu.actions.map((a, i) => (
            <button key={i} onClick={() => run(a)} className="block w-full px-3 py-1 text-left hover:bg-rose-600 hover:text-white">{a.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
