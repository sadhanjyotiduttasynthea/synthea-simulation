import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { Route, Routes } from 'react-router-dom'
import { MODULES, SHARED_PAGES } from './lib/modules'
import { Alert, Button, Spinner } from './components/ui'
import Dashboard from './pages/Dashboard'
import { useStore } from './store'
import { Workspace } from './workspace/Workspace'
import { log } from './workspace/wsStore'

const Materials = lazy(() => import('./pages/Materials'))
const Formulation = lazy(() => import('./pages/Formulation'))
const Optimizer = lazy(() => import('./pages/Optimizer'))
const Process = lazy(() => import('./pages/Process'))
const Printing = lazy(() => import('./pages/Printing'))
const Experiments = lazy(() => import('./pages/Experiments'))
const Reports = lazy(() => import('./pages/Reports'))
const Settings = lazy(() => import('./pages/Settings'))
const Definitions = lazy(() => import('./pages/Definitions'))
const Geometry = lazy(() => import('./pages/Geometry'))
const Libraries = lazy(() => import('./pages/Libraries'))
const Papers = lazy(() => import('./pages/Papers'))
const Models = lazy(() => import('./pages/Models'))
const Molecules = lazy(() => import('./pages/Molecules'))
const Twin = lazy(() => import('./pages/Twin'))

const PAGES: Record<string, React.ComponentType> = {
  // Synthea Materials
  '/libraries': Libraries, '/papers': Papers, '/models': Models, '/materials': Materials, '/formulation': Formulation, '/optimizer': Optimizer, '/molecules': Molecules,
  // Synthea Process
  '/process': Process, '/twin': Twin,
  // Synthea Print
  '/geometry': Geometry, '/printing': Printing,
  // shared
  '/': Dashboard, '/definitions': Definitions, '/experiments': Experiments, '/reports': Reports, '/settings': Settings,
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { log('error', 'ui', `${error.message}\n${info.componentStack?.split('\n').slice(0, 4).join('\n') ?? ''}`) }
  render() {
    if (this.state.error) return (
      <div className="max-w-xl p-4"><Alert kind="error" title="This view crashed">{this.state.error.message}<div className="mt-2"><Button size="sm" onClick={() => this.setState({ error: null })}>Retry</Button></div></Alert></div>
    )
    return this.props.children
  }
}

export default function App() {
  const { init, loading, error, dark, project } = useStore()
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    init()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])

  let body
  if (loading && !project) body = <div className="p-8"><Spinner label="Loading project data…" /></div>
  else if (error) body = <div className="max-w-xl p-8"><Alert kind="error" title="Compute engine unavailable">{error}<div className="mt-2"><Button size="sm" onClick={() => init()}>Retry</Button></div></Alert></div>
  else body = (
    <Suspense fallback={<Spinner label="Loading module…" />}>
      <ErrorBoundary>
        <Routes>
          {/* three modules (Synthea Materials / Process / Print) + shared pages, generated from lib/modules.ts */}
          {[...MODULES.flatMap((m) => m.pages), ...SHARED_PAGES].filter((p, i, a) => a.findIndex((q) => q.path === p.path) === i).map((p) => {
            const C = PAGES[p.path]
            return <Route key={p.path} path={p.path} element={<C />} />
          })}
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </ErrorBoundary>
    </Suspense>
  )
  return <Workspace>{body}</Workspace>
}
