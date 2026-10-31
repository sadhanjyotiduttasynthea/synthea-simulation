import {
  Atom, Beaker, BookOpen, Bot, Box, Boxes, Circle, Cylinder, FileDown, FileInput, FilePlus2, FileText, FlaskConical, FolderOpen, Gauge, Grid3x3,
  Hexagon, Home, Layers, LayoutPanelLeft, LibraryBig, LineChart, Moon, Network, PanelBottom, PanelLeft, PanelRight, Play, Plus, Printer, Ruler,
  Save, SaveAll, Scissors, ScrollText, Sigma, Sparkles, Square, Thermometer, Upload, Waves, Wind, type LucideIcon,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cx } from '../components/ui'
import { useStore } from '../store'
import { emitCommand } from './commands'
import { useWs } from './wsStore'

interface Tool { label: string; icon: LucideIcon; to?: string; cmd?: string; payload?: unknown; title?: string; big?: boolean }
interface Group { name: string; tools: Tool[] }

const TABS: { id: string; label: string; groups: Group[] }[] = [
  { id: 'file', label: 'File', groups: [
    { name: 'Project', tools: [
      { label: 'New', icon: FilePlus2, cmd: 'file.new', title: 'New project (Ctrl+N)', big: true },
      { label: 'Open…', icon: FolderOpen, cmd: 'file.open', title: 'Open project file (Ctrl+O)', big: true },
      { label: 'Save', icon: Save, cmd: 'file.save', title: 'Save project (Ctrl+S)', big: true },
      { label: 'Save As…', icon: SaveAll, cmd: 'file.saveAs', title: 'Save project as (Ctrl+Shift+S)' },
    ] },
    { name: 'Import', tools: [
      { label: 'Research PDF', icon: FileInput, to: '/papers', cmd: 'paper.import' },
      { label: 'STL geometry', icon: Upload, to: '/geometry', cmd: 'geometry.importStl' },
      { label: 'Library file', icon: LibraryBig, to: '/libraries', cmd: 'library.import' },
    ] },
    { name: 'Export', tools: [
      { label: 'Report', icon: FileDown, to: '/reports' },
      { label: 'STL', icon: FileDown, to: '/geometry', cmd: 'geometry.exportStl' },
    ] },
  ] },
  { id: 'home', label: 'Home', groups: [
    { name: 'Workspace', tools: [
      { label: 'Overview', icon: Home, to: '/', big: true },
      { label: 'Global definitions', icon: Sigma, to: '/definitions' },
    ] },
    { name: 'Formulation', tools: [
      { label: 'Formulation studio', icon: Beaker, to: '/formulation', big: true },
      { label: 'Optimizer', icon: Sparkles, to: '/optimizer' },
      { label: 'Experiments', icon: FlaskConical, to: '/experiments' },
    ] },
    { name: 'Layout', tools: [
      { label: 'Model builder', icon: PanelLeft, cmd: 'view.toggleLeft', title: 'Ctrl+1' },
      { label: 'Settings', icon: PanelRight, cmd: 'view.toggleRight', title: 'Ctrl+2' },
      { label: 'Messages', icon: PanelBottom, cmd: 'view.toggleBottom', title: 'Ctrl+3' },
      { label: 'Reset layout', icon: LayoutPanelLeft, cmd: 'view.resetLayout' },
      { label: 'Dark mode', icon: Moon, cmd: 'view.dark' },
    ] },
  ] },
  { id: 'materials', label: 'Materials', groups: [
    { name: 'Scientific libraries', tools: [
      { label: 'Library manager', icon: LibraryBig, to: '/libraries', big: true },
      { label: 'New library', icon: Plus, to: '/libraries', cmd: 'library.new' },
      { label: 'New material', icon: Plus, to: '/libraries', cmd: 'material.new' },
    ] },
    { name: 'Literature', tools: [
      { label: 'Research papers', icon: BookOpen, to: '/papers', big: true },
      { label: 'Import PDF', icon: FileInput, to: '/papers', cmd: 'paper.import' },
    ] },
    { name: 'Models & structures', tools: [
      { label: 'Model registry', icon: Sigma, to: '/models', big: true },
      { label: 'Molecules', icon: Atom, to: '/molecules' },
      { label: 'Ingredient table', icon: ScrollText, to: '/materials', title: 'Formulation ingredient table (nutrition)' },
    ] },
  ] },
  { id: 'geometry', label: 'Geometry', groups: [
    { name: '2D', tools: [
      { label: 'Rectangle', icon: Square, to: '/geometry', cmd: 'geometry.add', payload: 'rectangle' },
      { label: 'Circle', icon: Circle, to: '/geometry', cmd: 'geometry.add', payload: 'circle' },
      { label: 'Polygon', icon: Hexagon, to: '/geometry', cmd: 'geometry.add', payload: 'polygon' },
    ] },
    { name: '3D', tools: [
      { label: 'Cuboid', icon: Box, to: '/geometry', cmd: 'geometry.add', payload: 'cuboid', big: true },
      { label: 'Cylinder', icon: Cylinder, to: '/geometry', cmd: 'geometry.add', payload: 'cylinder' },
      { label: 'Sphere', icon: Circle, to: '/geometry', cmd: 'geometry.add', payload: 'sphere' },
      { label: 'Extrude', icon: Layers, to: '/geometry', cmd: 'geometry.add', payload: 'extrusion' },
    ] },
    { name: 'View', tools: [
      { label: 'Section', icon: Scissors, to: '/geometry', cmd: 'geometry.section' },
      { label: 'Measure', icon: Ruler, to: '/geometry', cmd: 'geometry.measure' },
      { label: 'Import STL', icon: Upload, to: '/geometry', cmd: 'geometry.importStl' },
    ] },
  ] },
  { id: 'physics', label: 'Physics', groups: [
    { name: 'Digital twin', tools: [
      { label: 'Digital twins', icon: Boxes, to: '/twin', big: true },
      { label: 'New twin', icon: Plus, to: '/twin', cmd: 'twin.new' },
    ] },
    { name: 'Add physics', tools: [
      { label: 'Heat transfer', icon: Thermometer, to: '/twin', cmd: 'twin.addPhysics', payload: 'heat' },
      { label: 'Laminar flow', icon: Waves, to: '/twin', cmd: 'twin.addPhysics', payload: 'flow' },
      { label: 'Diffusion', icon: Wind, to: '/twin', cmd: 'twin.addPhysics', payload: 'diffusion' },
      { label: 'Kinetics', icon: Atom, to: '/twin', cmd: 'twin.addPhysics', payload: 'kinetics' },
    ] },
    { name: 'Process', tools: [
      { label: 'Process line', icon: Network, to: '/process' },
      { label: '3D printing', icon: Printer, to: '/printing' },
      { label: 'Molecular view', icon: Atom, to: '/molecules' },
    ] },
  ] },
  { id: 'mesh', label: 'Mesh', groups: [
    { name: 'Mesh', tools: [
      { label: 'Build mesh', icon: Grid3x3, to: '/twin?tab=mesh', cmd: 'mesh.build', big: true },
      { label: 'Mesh settings', icon: Gauge, to: '/twin?tab=mesh' },
    ] },
  ] },
  { id: 'study', label: 'Study', groups: [
    { name: 'Compute', tools: [
      { label: 'Compute', icon: Play, to: '/twin?tab=study', cmd: 'study.compute', title: 'Run study (F5)', big: true },
      { label: 'Study settings', icon: Gauge, to: '/twin?tab=study' },
    ] },
    { name: 'Virtual experiments', tools: [
      { label: 'Experiment planning', icon: FlaskConical, to: '/experiments' },
      { label: 'Optimizer', icon: Sparkles, to: '/optimizer' },
    ] },
  ] },
  { id: 'results', label: 'Results', groups: [
    { name: 'Results', tools: [
      { label: 'Result plots', icon: LineChart, to: '/twin?tab=results', big: true },
      { label: 'Export data', icon: FileDown, to: '/twin?tab=results', cmd: 'results.export' },
      { label: 'Report', icon: FileText, to: '/reports' },
    ] },
  ] },
  { id: 'ai', label: 'AI Assistant', groups: [
    { name: 'Assistant', tools: [
      { label: 'Open assistant', icon: Bot, cmd: 'assistant.open', big: true },
      { label: 'Extract from papers', icon: Sparkles, to: '/papers' },
      { label: 'AI settings', icon: Gauge, to: '/settings' },
    ] },
  ] },
]

export function Ribbon() {
  const { ribbonTab, setRibbonTab } = useWs()
  const nav = useNavigate()
  const project = useStore((s) => s.project)
  const tab = TABS.find((t) => t.id === ribbonTab) ?? TABS[1]
  const run = (t: Tool) => {
    if (t.to) nav(t.to)
    if (t.cmd) emitCommand(t.cmd, t.payload)
  }
  return (
    <div className="shrink-0 border-b border-black/40 bg-[#16181d] text-neutral-300 select-none">
      <div className="flex items-end gap-0.5 px-2 pt-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setRibbonTab(t.id)}
            className={cx('rounded-t px-3 py-1 text-[12px] tracking-wide', t.id === tab.id ? 'bg-[#23262d] text-white shadow-[inset_0_2px_0_#e11d48]' : 'text-neutral-400 hover:text-white')}>
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <span className="pb-1 pr-2 text-[11px] text-neutral-500">{project?.name}</span>
      </div>
      <div className="flex h-[74px] items-stretch gap-0 overflow-x-auto bg-[#23262d] px-1.5 py-1">
        {tab.groups.map((g) => (
          <div key={g.name} className="flex shrink-0 flex-col border-r border-white/5 px-1.5 last:border-0">
            <div className="flex flex-1 items-start gap-0.5">
              {g.tools.filter((t) => t.big).map((t) => (
                <button key={t.label} title={t.title ?? t.label} onClick={() => run(t)} className="flex w-[64px] flex-col items-center gap-1 rounded px-1 py-1 text-[10.5px] leading-tight text-neutral-200 hover:bg-white/10">
                  <t.icon className="h-5 w-5 text-rose-400" strokeWidth={1.6} />
                  <span className="text-center">{t.label}</span>
                </button>
              ))}
              <div className="grid grid-flow-col grid-rows-3 gap-x-1">
                {g.tools.filter((t) => !t.big).map((t) => (
                  <button key={t.label} title={t.title ?? t.label} onClick={() => run(t)} className="flex h-[18px] items-center gap-1.5 rounded px-1.5 text-[11px] text-neutral-300 hover:bg-white/10 hover:text-white">
                    <t.icon className="h-3.5 w-3.5 text-cyan-300/80" strokeWidth={1.7} />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-center text-[9.5px] uppercase tracking-[0.12em] text-neutral-500">{g.name}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
