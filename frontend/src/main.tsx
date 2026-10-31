import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { initApi, isDesktop } from './lib/api'

const root = createRoot(document.getElementById('root')!)

async function boot() {
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
