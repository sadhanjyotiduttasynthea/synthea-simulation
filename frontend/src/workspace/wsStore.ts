import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type LogLevel = 'info' | 'warn' | 'error' | 'success'
export interface LogEntry { id: number; t: string; level: LogLevel; source: string; message: string }
export interface EquationEntry { title: string; latex: string; note?: string; status?: string }
export type BottomTab = 'results' | 'plots' | 'equations' | 'log' | 'warnings' | 'assistant' | 'data'
export interface Selection { kind: string; id?: string; label?: string }

interface WsState {
  ribbonTab: string
  showLeft: boolean
  showRight: boolean
  showBottom: boolean
  bottomTab: BottomTab
  log: LogEntry[]
  equations: EquationEntry[]
  inspectorEl: HTMLElement | null
  resultsEl: HTMLElement | null
  plotsEl: HTMLElement | null
  selection: Selection | null
  recent: { name: string; path: string; t: string }[]
  setRibbonTab: (t: string) => void
  toggle: (p: 'left' | 'right' | 'bottom', v?: boolean) => void
  setBottomTab: (t: BottomTab) => void
  addLog: (level: LogLevel, source: string, message: string) => void
  clearLog: () => void
  setEquations: (e: EquationEntry[]) => void
  setSlots: (s: Partial<Pick<WsState, 'inspectorEl' | 'resultsEl' | 'plotsEl'>>) => void
  select: (s: Selection | null) => void
  addRecent: (name: string, path: string) => void
}

let logId = 1

export const useWs = create<WsState>()(
  persist(
    (set, get) => ({
      ribbonTab: 'home',
      showLeft: true,
      showRight: true,
      showBottom: true,
      bottomTab: 'log',
      log: [],
      equations: [],
      inspectorEl: null,
      resultsEl: null,
      plotsEl: null,
      selection: null,
      recent: [],
      setRibbonTab: (t) => set({ ribbonTab: t }),
      toggle: (p, v) => {
        const key = p === 'left' ? 'showLeft' : p === 'right' ? 'showRight' : 'showBottom'
        set({ [key]: v ?? !get()[key] } as Partial<WsState>)
      },
      setBottomTab: (t) => set({ bottomTab: t, showBottom: true }),
      addLog: (level, source, message) => {
        const e = { id: logId++, t: new Date().toLocaleTimeString(), level, source, message }
        set({ log: [...get().log.slice(-499), e] })
      },
      clearLog: () => set({ log: [] }),
      setEquations: (equations) => set({ equations }),
      setSlots: (s) => set(s),
      select: (selection) => set({ selection }),
      addRecent: (name, path) => set({ recent: [{ name, path, t: new Date().toISOString() }, ...get().recent.filter((r) => r.path !== path)].slice(0, 10) }),
    }),
    { name: 'synthea-workspace', partialize: (s) => ({ ribbonTab: s.ribbonTab, showLeft: s.showLeft, showRight: s.showRight, showBottom: s.showBottom, bottomTab: s.bottomTab, recent: s.recent }) },
  ),
)

export const log = (level: LogLevel, source: string, message: string) => useWs.getState().addLog(level, source, message)
