import {
  Beaker, Bot, Box, Factory, FileText, FlaskConical, FolderOpen, LayoutDashboard, Library, Moon, Printer, Settings, Sparkles, Sun, X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useStore } from '../store'
import { Assistant } from './Assistant'
import { cx } from './ui'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/materials', label: 'Materials Library', icon: Library },
  { to: '/formulation', label: 'Formulation Studio', icon: Beaker },
  { to: '/optimizer', label: 'AI Optimizer', icon: Sparkles },
  { to: '/process', label: 'Process Simulator', icon: Factory },
  { to: '/printing', label: '3D Printing Lab', icon: Printer },
  { to: '/experiments', label: 'Experiments', icon: FlaskConical },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Layout({ children }: { children: ReactNode }) {
  const { project, projects, selectProject, dark, setDark, toasts, dismiss, openAssistant, assistantOpen, toast } = useStore()
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 text-neutral-300 md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <Box className="h-5 w-5 text-red-500" />
          <div>
            <div className="text-sm font-semibold tracking-tight text-white">Synthea Simulation</div>
            <div className="text-[10px] uppercase tracking-widest text-neutral-500">Virtual food engineering</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cx('flex items-center gap-2.5 rounded px-2.5 py-1.5 text-[13px]', isActive ? 'bg-neutral-800 text-white shadow-[inset_2px_0_0_#dc2626]' : 'hover:bg-neutral-900 hover:text-white')
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-neutral-800 p-3 text-[10px] leading-relaxed text-neutral-500">
          Computational decision support. All predictions require physical validation.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-900">
          <FolderOpen className="h-4 w-4 text-neutral-500" />
          <select
            aria-label="Active project"
            className="h-7 max-w-[260px] rounded border border-neutral-300 bg-white px-2 text-sm font-medium dark:border-neutral-700 dark:bg-neutral-950"
            value={project?.id ?? ''}
            onChange={(e) => selectProject(e.target.value).catch((err) => toast(err.message, 'error'))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <nav className="flex gap-1 overflow-x-auto md:hidden">
            {NAV.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to} end={to === '/'} title={label} className={({ isActive }) => cx('rounded p-1.5', isActive ? 'bg-neutral-200 dark:bg-neutral-800' : '')}>
                <Icon className="h-4 w-4" />
              </NavLink>
            ))}
          </nav>
          <div className="flex-1" />
          <button
            onClick={() => openAssistant(!assistantOpen)}
            className={cx('flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-medium', assistantOpen ? 'border-accent bg-accent text-white' : 'border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800')}
          >
            <Bot className="h-3.5 w-3.5" /> Assistant
          </button>
          <button onClick={() => setDark(!dark)} className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="Toggle dark mode">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="@container min-w-0 flex-1 overflow-y-auto p-4">{children}</main>
          {assistantOpen && <Assistant />}
        </div>
      </div>

      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex max-w-sm items-start gap-2 rounded border px-3 py-2 text-xs shadow-lg',
              t.kind === 'error' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200' : t.kind === 'success' ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-200 dark:bg-white dark:text-neutral-900' : 'border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900',
            )}
          >
            <span className="flex-1">{t.message}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><X className="h-3 w-3" /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
