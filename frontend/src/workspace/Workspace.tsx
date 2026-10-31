import { Box, PanelBottomClose, PanelLeftClose, PanelRightClose, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { useLocation } from 'react-router-dom'
import { cx } from '../components/ui'
import { api } from '../lib/api'
import { useStore } from '../store'
import { BottomPanel } from './BottomPanel'
import { emitCommand, useCommand } from './commands'
import { FileCommands } from './FileCommands'
import { ModelTree } from './ModelTree'
import { Ribbon } from './Ribbon'
import { useWs } from './wsStore'

const HELP: Record<string, { title: string; text: string }> = {
  '/': { title: 'Project overview', text: 'Select a node in the Model Builder to open it. Right-click nodes for actions. Ribbon tabs group the tools of each modelling step.' },
  '/definitions': { title: 'Global definitions', text: 'Project parameters and physical constants usable in equations and studies.' },
  '/libraries': { title: 'Scientific libraries', text: 'Global, reusable material knowledge. Properties are stored with their experimental conditions and sources; conflicting values coexist.' },
  '/papers': { title: 'Research papers', text: 'Import PDFs, extract candidate properties and equations, and approve them after review. Nothing enters a library without review.' },
  '/models': { title: 'Model registry', text: 'Equations with parameters, units, validity ranges and approval status. Only approved models are used in simulations.' },
  '/geometry': { title: 'Geometry', text: 'Create 2D/3D objects, edit dimensions and transforms, assign materials, import/export STL.' },
  '/molecules': { title: 'Molecular structures', text: 'Computed 3D conformers and user-loaded structure files. Interaction scenes are labelled conceptual unless computed.' },
  '/twin': { title: 'Digital twin', text: 'Geometry + materials + physics + conditions + mesh + study + results + validation, with explicit model provenance.' },
}

function SepH() {
  return <Separator className="w-[3px] bg-neutral-300 transition-colors hover:bg-rose-500 data-[separator=active]:bg-rose-600 dark:bg-black" />
}
function SepV() {
  return <Separator className="h-[3px] bg-neutral-300 transition-colors hover:bg-rose-500 data-[separator=active]:bg-rose-600 dark:bg-black" />
}

function PanelHeader({ title, onClose, children }: { title: string; onClose?: () => void; children?: ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-200 bg-neutral-100 px-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-500 dark:border-white/10 dark:bg-[#1b1e23] dark:text-neutral-400">
      <span className="truncate">{title}</span>
      {children}
      <div className="flex-1" />
      {onClose && <button onClick={onClose} className="text-neutral-400 hover:text-rose-600" title="Hide panel"><X className="h-3.5 w-3.5" /></button>}
    </div>
  )
}

export function Workspace({ children }: { children: ReactNode }) {
  const { showLeft, showRight, showBottom, toggle, setSlots, selection, setBottomTab } = useWs()
  const { dark, setDark, toasts, dismiss } = useStore()
  const loc = useLocation()
  const [layoutKey, setLayoutKey] = useState(0)
  const inspRef = useRef<HTMLDivElement>(null)
  const [inspEmpty, setInspEmpty] = useState(true)
  const help = HELP[loc.pathname] ?? { title: 'Module', text: 'Classic Synthea module embedded in the workspace. Hide side panels (Home → Layout) for more space.' }

  const hLayout = useDefaultLayout({ id: `synthea-h-${showLeft ? 1 : 0}${showRight ? 1 : 0}`, storage: localStorage })
  const vLayout = useDefaultLayout({ id: `synthea-v-${showBottom ? 1 : 0}`, storage: localStorage })

  useEffect(() => {
    setSlots({ inspectorEl: inspRef.current })
    const el = inspRef.current
    if (!el) return
    const check = () => setInspEmpty(el.childElementCount === 0)
    check()
    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true })
    return () => mo.disconnect()
  }, [setSlots, showRight, layoutKey])

  useCommand('view.toggleLeft', () => toggle('left'))
  useCommand('view.toggleRight', () => toggle('right'))
  useCommand('view.toggleBottom', () => toggle('bottom'))
  useCommand('view.dark', () => setDark(!useStore.getState().dark))
  useCommand('assistant.open', () => setBottomTab('assistant'))
  useCommand('view.resetLayout', () => {
    Object.keys(localStorage).filter((k) => k.startsWith('react-resizable-panels') || k.includes('synthea-h-') || k.includes('synthea-v-')).forEach((k) => localStorage.removeItem(k))
    toggle('left', true)
    toggle('right', true)
    toggle('bottom', true)
    setLayoutKey((k) => k + 1)
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.key === 'F5') { e.preventDefault(); emitCommand('study.compute') }
      else if (mod && k === 's') { e.preventDefault(); emitCommand(e.shiftKey ? 'file.saveAs' : 'file.save') }
      else if (mod && k === 'o') { e.preventDefault(); emitCommand('file.open') }
      else if (mod && k === 'n' && e.altKey) { e.preventDefault(); emitCommand('file.new') }
      else if (mod && e.key === '1') { e.preventDefault(); toggle('left') }
      else if (mod && e.key === '2') { e.preventDefault(); toggle('right') }
      else if (mod && e.key === '3') { e.preventDefault(); toggle('bottom') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  return (
    <div className="flex h-full flex-col bg-[#0f1114]">
      <FileCommands />
      <div className="flex h-8 shrink-0 items-center gap-2 bg-[#0f1114] px-3 text-neutral-300">
        <Box className="h-4 w-4 text-rose-500" />
        <span className="text-[12.5px] font-semibold tracking-wide text-white">Synthea Simulation</span>
        <span className="text-[10px] uppercase tracking-[0.25em] text-neutral-500">scientific food engineering workstation</span>
        <div className="flex-1" />
        <button onClick={() => toggle('left')} title="Model Builder (Ctrl+1)" className={cx('rounded p-1', showLeft ? 'text-cyan-300' : 'text-neutral-600')}><PanelLeftClose className="h-3.5 w-3.5" /></button>
        <button onClick={() => toggle('bottom')} title="Messages (Ctrl+3)" className={cx('rounded p-1', showBottom ? 'text-cyan-300' : 'text-neutral-600')}><PanelBottomClose className="h-3.5 w-3.5" /></button>
        <button onClick={() => toggle('right')} title="Settings (Ctrl+2)" className={cx('rounded p-1', showRight ? 'text-cyan-300' : 'text-neutral-600')}><PanelRightClose className="h-3.5 w-3.5" /></button>
        <button onClick={() => setDark(!dark)} className="rounded px-1.5 text-[10.5px] text-neutral-400 hover:text-white">{dark ? 'Light' : 'Dark'}</button>
      </div>
      <Ribbon />
      <div className="min-h-0 flex-1" key={layoutKey}>
        <Group orientation="horizontal" id={`synthea-h-${showLeft ? 1 : 0}${showRight ? 1 : 0}`} defaultLayout={hLayout.defaultLayout} onLayoutChanged={hLayout.onLayoutChanged}>
          {showLeft && (
            <>
              <Panel id="left" defaultSize="18" minSize="180px" maxSize="40" className="flex flex-col bg-neutral-50 dark:bg-[#17191d]">
                <PanelHeader title="Model Builder" onClose={() => toggle('left', false)} />
                <div className="min-h-0 flex-1 text-neutral-800 dark:text-neutral-200"><ModelTree /></div>
              </Panel>
              <SepH />
            </>
          )}
          <Panel id="center" minSize="30" className="flex flex-col">
            <Group orientation="vertical" id={`synthea-v-${showBottom ? 1 : 0}`} defaultLayout={vLayout.defaultLayout} onLayoutChanged={vLayout.onLayoutChanged}>
              <Panel id="main" minSize="25" className="flex flex-col">
                <div className="@container min-h-0 flex-1 overflow-auto bg-neutral-100 p-3 text-neutral-900 dark:bg-[#101215] dark:text-neutral-100">{children}</div>
              </Panel>
              {showBottom && (
                <>
                  <SepV />
                  <Panel id="bottom" defaultSize="18" minSize="80px" className="flex flex-col text-neutral-900 dark:text-neutral-100">
                    <BottomPanel />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          {showRight && (
            <>
              <SepH />
              <Panel id="right" defaultSize="22" minSize="220px" maxSize="45" className="flex flex-col bg-white text-neutral-900 dark:bg-[#17191d] dark:text-neutral-100">
                <PanelHeader title="Settings" onClose={() => toggle('right', false)}>
                  {selection?.label && <span className="truncate font-normal normal-case tracking-normal text-neutral-400">· {selection.label}</span>}
                </PanelHeader>
                <div className="min-h-0 flex-1 overflow-auto">
                  <div ref={inspRef} className="space-y-3 p-2.5" />
                  {inspEmpty && (
                    <div className="space-y-2 p-3 text-xs text-neutral-600 dark:text-neutral-400">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{help.title}</div>
                      <p>{help.text}</p>
                    </div>
                  )}
                </div>
              </Panel>
            </>
          )}
        </Group>
      </div>
      <StatusBar />
      <div className="pointer-events-none fixed bottom-8 right-4 z-[90] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex max-w-sm items-start gap-2 rounded border px-3 py-2 text-xs shadow-lg', t.kind === 'error' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200' : t.kind === 'success' ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100')}>
            <span className="flex-1">{t.message}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><X className="h-3 w-3" /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusBar() {
  const log = useWs((s) => s.log)
  const last = log[log.length - 1]
  const [backend, setBackend] = useState<'ok' | 'down' | '…'>('…')
  useEffect(() => {
    let alive = true
    const ping = () => api.get('/api/health', true).then(() => alive && setBackend('ok')).catch(() => alive && setBackend('down'))
    ping()
    const t = setInterval(ping, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const desktop = '__TAURI_INTERNALS__' in window
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-black/50 bg-[#0f1114] px-3 text-[10.5px] text-neutral-400">
      <span className="flex items-center gap-1.5"><span className={cx('h-1.5 w-1.5 rounded-full', backend === 'ok' ? 'bg-emerald-400' : backend === 'down' ? 'bg-red-500' : 'bg-neutral-500')} />Compute engine {backend === 'ok' ? 'ready' : backend === 'down' ? 'unreachable' : '…'}</span>
      <span>{desktop ? 'Desktop' : 'Browser'} mode</span>
      <span className="truncate">{last ? `${last.source}: ${last.message}` : 'Ready'}</span>
    </div>
  )
}
