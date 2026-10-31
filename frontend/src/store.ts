import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from './lib/api'
import type { Formulation, Ingredient, Project } from './lib/types'

export interface Toast { id: number; message: string; kind: 'info' | 'success' | 'error' }

/** Latest computed results per project (kept for report generation). */
export interface Results {
  optimization?: unknown
  optimizationRequest?: unknown
  process?: unknown
  print?: unknown
  printParams?: unknown
  recommendation?: unknown
  scenario?: unknown
  scenarioInputs?: unknown
}

interface State {
  projectId: string | null
  projects: Project[]
  project: Project | null
  ingredients: Ingredient[]
  formulations: Formulation[]
  loading: boolean
  error: string | null
  dark: boolean
  toasts: Toast[]
  assistantOpen: boolean
  assistantPage: string
  assistantContext: Record<string, unknown>
  results: Record<string, Results>

  init: () => Promise<void>
  selectProject: (id: string) => Promise<void>
  refreshProjects: () => Promise<void>
  refreshIngredients: () => Promise<void>
  refreshFormulations: () => Promise<void>
  saveProject: (p: Project) => Promise<Project>
  saveFormulation: (f: Formulation) => Promise<Formulation>
  setActiveFormulation: (id: string) => Promise<void>
  setDark: (v: boolean) => void
  toast: (message: string, kind?: Toast['kind']) => void
  dismiss: (id: number) => void
  setAssistant: (page: string, ctx: Record<string, unknown>) => void
  openAssistant: (v: boolean) => void
  setResult: <K extends keyof Results>(key: K, value: Results[K]) => void
}

let toastId = 1

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      projectId: null,
      projects: [],
      project: null,
      ingredients: [],
      formulations: [],
      loading: true,
      error: null,
      dark: false,
      toasts: [],
      assistantOpen: false,
      assistantPage: 'dashboard',
      assistantContext: {},
      results: {},

      init: async () => {
        set({ loading: true, error: null })
        try {
          const [projects, ingredients] = await Promise.all([api.get<Project[]>('/api/projects'), api.get<Ingredient[]>('/api/ingredients')])
          set({ projects, ingredients })
          const pid = get().projectId && projects.some((p) => p.id === get().projectId) ? get().projectId! : projects[0]?.id
          if (pid) await get().selectProject(pid)
          set({ loading: false })
        } catch (e) {
          set({ loading: false, error: (e as Error).message })
        }
      },
      selectProject: async (id) => {
        const [project, formulations] = await Promise.all([
          api.get<Project>(`/api/projects/${id}`),
          api.get<Formulation[]>(`/api/formulations?project_id=${id}`),
        ])
        set({ projectId: id, project, formulations })
      },
      refreshProjects: async () => {
        set({ projects: await api.get<Project[]>('/api/projects') })
      },
      refreshIngredients: async () => {
        set({ ingredients: await api.get<Ingredient[]>('/api/ingredients') })
      },
      refreshFormulations: async () => {
        const id = get().projectId
        if (id) set({ formulations: await api.get<Formulation[]>(`/api/formulations?project_id=${id}`) })
      },
      saveProject: async (p) => {
        const saved = await api.put<Project>(`/api/projects/${p.id}`, p)
        set({ project: saved, projects: get().projects.map((x) => (x.id === saved.id ? saved : x)) })
        return saved
      },
      saveFormulation: async (f) => {
        const saved = f.id ? await api.put<Formulation>(`/api/formulations/${f.id}`, f) : await api.post<Formulation>('/api/formulations', f)
        await get().refreshFormulations()
        return saved
      },
      setActiveFormulation: async (id) => {
        const p = get().project
        if (!p || p.active_formulation_id === id) return
        await get().saveProject({ ...p, active_formulation_id: id })
      },
      setDark: (v) => {
        document.documentElement.classList.toggle('dark', v)
        set({ dark: v })
      },
      toast: (message, kind = 'info') => {
        const id = toastId++
        set({ toasts: [...get().toasts, { id, message, kind }] })
        setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 3500)
      },
      dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
      setAssistant: (page, ctx) => set({ assistantPage: page, assistantContext: ctx }),
      openAssistant: (v) => set({ assistantOpen: v }),
      setResult: (key, value) => {
        const pid = get().projectId
        if (!pid) return
        const cur = get().results[pid] ?? {}
        set({ results: { ...get().results, [pid]: { ...cur, [key]: value } } })
      },
    }),
    {
      name: 'synthea-ui',
      partialize: (s) => ({ projectId: s.projectId, dark: s.dark, results: s.results }),
    },
  ),
)

export const useIngredientMap = () => {
  const ings = useStore((s) => s.ingredients)
  return Object.fromEntries(ings.map((i) => [i.id, i])) as Record<string, Ingredient>
}

export const useResults = (): Results => {
  const pid = useStore((s) => s.projectId)
  const r = useStore((s) => s.results)
  return (pid && r[pid]) || {}
}

export const useActiveFormulation = (): Formulation | undefined => {
  const p = useStore((s) => s.project)
  const fs = useStore((s) => s.formulations)
  return fs.find((f) => f.id === p?.active_formulation_id) ?? fs[0]
}
