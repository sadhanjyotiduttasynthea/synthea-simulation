import { lazy, Suspense, useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Alert, Button, Spinner } from './components/ui'
import Dashboard from './pages/Dashboard'
import { useStore } from './store'

const Materials = lazy(() => import('./pages/Materials'))
const Formulation = lazy(() => import('./pages/Formulation'))
const Optimizer = lazy(() => import('./pages/Optimizer'))
const Process = lazy(() => import('./pages/Process'))
const Printing = lazy(() => import('./pages/Printing'))
const Experiments = lazy(() => import('./pages/Experiments'))
const Reports = lazy(() => import('./pages/Reports'))
const Settings = lazy(() => import('./pages/Settings'))

export default function App() {
  const { init, loading, error, dark, project } = useStore()
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    init()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  let body
  if (loading && !project) body = <div className="p-8"><Spinner label="Loading project data…" /></div>
  else if (error)
    body = (
      <div className="max-w-xl p-8">
        <Alert kind="error" title="Backend unavailable">{error}<div className="mt-2"><Button size="sm" onClick={() => init()}>Retry</Button></div></Alert>
      </div>
    )
  else
    body = (
      <Suspense fallback={<Spinner label="Loading module…" />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/materials" element={<Materials />} />
          <Route path="/formulation" element={<Formulation />} />
          <Route path="/optimizer" element={<Optimizer />} />
          <Route path="/process" element={<Process />} />
          <Route path="/printing" element={<Printing />} />
          <Route path="/experiments" element={<Experiments />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </Suspense>
    )
  return <Layout>{body}</Layout>
}
