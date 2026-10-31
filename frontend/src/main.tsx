import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { initApi, isDesktop } from './lib/api'

const root = createRoot(document.getElementById('root')!)

async function boot() {
  root.render(
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1114', color: '#d4d4d4', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#fff' }}>Synthea Simulation</div>
        <div style={{ fontSize: 12, marginTop: 8, color: '#9ca3af' }}>Starting the local compute engine… (the first launch can take up to a minute)</div>
      </div>
    </div>,
  )
  try {
    await initApi()
    if (isDesktop()) (await import('./lib/desktop')).bindNativeMenu()
  } catch (e) {
    root.render(<div style={{ padding: 32, fontFamily: 'sans-serif', color: '#b91c1c' }}><h2>Synthea Simulation could not start</h2><p>{(e as Error).message}</p></div>)
    return
  }
  root.render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}
boot()
