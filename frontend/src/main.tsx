import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { initApi, isDesktop } from './lib/api'

const root = createRoot(document.getElementById('root')!)

/** Shown when the single-file build is opened directly from disk (file://): wait for the local engine, then open it. */
function FileLauncher() {
  const [found, setFound] = useState(false)
  useEffect(() => {
    const t = setInterval(() => {
      // no-cors: only checks that the engine answers; no data is read across origins
      fetch('http://127.0.0.1:8000/api/health', { mode: 'no-cors', cache: 'no-store' }).then(() => {
        setFound(true)
        clearInterval(t)
        window.location.href = 'http://localhost:8000/'
      }).catch(() => undefined)
    }, 1500)
    return () => clearInterval(t)
  }, [])
  const box: React.CSSProperties = { maxWidth: 620, background: '#16181d', border: '1px solid #2b2f36', borderRadius: 10, padding: 28, lineHeight: 1.6 }
  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1114', color: '#d4d4d4', fontFamily: 'Inter, system-ui, sans-serif', padding: 20 }}>
      <div style={box}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>Synthea Simulation</div>
        <div style={{ fontSize: 12, letterSpacing: 2, color: '#e11d48', textTransform: 'uppercase', marginBottom: 16 }}>scientific food engineering workstation</div>
        {found ? <p>Compute engine found — opening the platform…</p> : (
          <>
            <p>This page is the platform's interface. The scientific calculations run in a small program on your computer (the <b>compute engine</b>), which is not running yet.</p>
            <ol style={{ paddingLeft: 20 }}>
              <li>In the project folder, double-click <b>Start-Synthea.bat</b>.</li>
              <li>Wait for the black window to say <i>"Application startup complete"</i> (the first time takes a few minutes).</li>
              <li>This page then opens the platform automatically at <b>http://localhost:8000</b>.</li>
            </ol>
            <p style={{ fontSize: 13, color: '#9ca3af' }}>Waiting for the compute engine… <span style={{ color: '#22d3ee' }}>●</span></p>
          </>
        )}
      </div>
    </div>
  )
}

async function boot() {
  if (window.location.protocol === 'file:') {
    root.render(<FileLauncher />)
    return
  }
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
