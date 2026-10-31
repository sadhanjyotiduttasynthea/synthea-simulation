import { Atom, BookOpen, Boxes, Cuboid, FlaskConical, Gauge, LayoutDashboard, LibraryBig, LineChart, Network, Printer, Settings, Sigma, Sparkles, Beaker, Wand2, type LucideIcon } from 'lucide-react'

/**
 * Navigation model: exactly three Synthea modules. Every page belongs to one module,
 * except the shared pages (dashboard, experiments, reports, settings, global definitions).
 * Routes, the model tree, the dashboard and the breadcrumb are all generated from this list.
 */
export interface ModulePage { path: string; label: string; icon: LucideIcon; query?: string; description: string }
export interface SyntheaModule { id: 'materials' | 'process' | 'print'; label: string; tagline: string; pages: ModulePage[] }

export const MODULES: SyntheaModule[] = [
  {
    id: 'materials', label: 'Synthea Materials', tagline: 'Knowledge from papers → ingredient library → virtual formulation and optimisation',
    pages: [
      { path: '/libraries', label: 'Libraries', icon: LibraryBig, description: 'Global scientific libraries: materials and condition-aware property records.' },
      { path: '/papers', label: 'Papers', icon: BookOpen, description: 'Upload research PDFs; text, tables, metadata and summaries.' },
      { path: '/papers', query: 'tab=review', label: 'Extraction Review', icon: Wand2, description: 'Review and approve extracted values and equations against their source pages.' },
      { path: '/models', label: 'Models', icon: Sigma, description: 'Equations and numerical models with parameters, validity ranges and sources.' },
      { path: '/materials', label: 'Materials', icon: Beaker, description: 'Ingredient table (faba bean protein isolate/concentrate and co-ingredients) with provenance.' },
      { path: '/formulation', label: 'Formulation', icon: FlaskConical, description: 'Virtual formulation: composition, nutrition, cost, sensory/technical profile, interactions.' },
      { path: '/optimizer', label: 'Optimizer', icon: Sparkles, description: 'Cost/protein optimisation with constraints, Pareto front and infeasibility diagnosis.' },
      { path: '/molecules', label: 'Molecules', icon: Atom, description: 'Molecular structures, computed properties and interaction scenes.' },
    ],
  },
  {
    id: 'process', label: 'Synthea Process', tagline: 'Plant-based sausage line, digital twins and texture classes',
    pages: [
      { path: '/process', label: 'Process Simulator', icon: Network, description: 'Flowsheet of the production line with mass and energy balances.' },
      { path: '/twin', label: 'Digital Twin', icon: Boxes, description: '2-D heat, flow, solid-mechanics and diffusion studies on the product cross-section.' },
    ],
  },
  {
    id: 'print', label: 'Synthea Print', tagline: 'Geometry, extrusion method, toolpaths and manufacturability',
    pages: [
      { path: '/geometry', label: 'Geometry', icon: Cuboid, description: 'Draw or import (STL) the prototype geometry.' },
      { path: '/printing', label: '3D Printing Lab', icon: Printer, description: 'Extrusion method, toolpaths, nozzle pressure and G-code export.' },
    ],
  },
]

export const SHARED_PAGES: ModulePage[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, description: 'Project overview.' },
  { path: '/definitions', label: 'Global Definitions', icon: Gauge, description: 'Project parameters and constants.' },
  { path: '/experiments', label: 'Experiments', icon: FlaskConical, description: 'Experimental records, DoE and active learning.' },
  { path: '/reports', label: 'Reports', icon: LineChart, description: 'PDF / JSON / CSV reports.' },
  { path: '/settings', label: 'Settings', icon: Settings, description: 'Project settings, AI configuration, data.' },
]

export const pageHref = (p: ModulePage) => (p.query ? `${p.path}?${p.query}` : p.path)

/** Module and page for a location (query-specific pages win, e.g. Extraction Review). */
export function locate(pathname: string, search: string): { module: SyntheaModule | null; page: ModulePage | null } {
  const q = new URLSearchParams(search)
  for (const m of MODULES) {
    const exact = m.pages.find((p) => p.path === pathname && p.query && p.query.split('&').every((kv) => { const [k, v] = kv.split('='); return q.get(k) === v }))
    if (exact) return { module: m, page: exact }
  }
  for (const m of MODULES) {
    const p = m.pages.find((x) => x.path === pathname && !x.query)
    if (p) return { module: m, page: p }
  }
  return { module: null, page: SHARED_PAGES.find((p) => p.path === pathname) ?? null }
}
