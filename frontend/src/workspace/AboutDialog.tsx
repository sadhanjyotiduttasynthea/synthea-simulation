import { useState } from 'react'
import { Button, KV, Modal } from '../components/ui'
import { api, isDesktop } from '../lib/api'
import { useCommand } from './commands'

/** About / diagnostics dialog (Help → About). Shows version, data folder and the compute-engine log for error reports. */
export function AboutDialog() {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<{ version: string; data_dir: string; url: string; log: string[] } | null>(null)
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  useCommand('help.about', async () => {
    setOpen(true)
    api.get<Record<string, unknown>>('/api/health', true).then(setHealth).catch(() => setHealth(null))
    if (isDesktop()) setInfo(await (await import('../lib/desktop')).engineInfo())
  })
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="About Synthea Simulation" wide footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
      <div className="space-y-3 text-xs">
        <p>Scientific food-engineering workstation: scientific libraries, research-paper extraction with human review, model registry, geometry, molecular views, digital twins and virtual experiments.</p>
        <KV rows={[
          ['Application version', info?.version ?? '2.0.0'], ['Mode', isDesktop() ? 'Desktop (Tauri 2)' : 'Browser'],
          ['Compute engine', health ? `ready (${info?.url ?? 'proxied /api'})` : 'unreachable'], ['Local data folder', info?.data_dir ?? 'backend/data (development)'],
        ]} />
        {info && (
          <div>
            <div className="mb-1 font-semibold">Compute-engine log (include in error reports)</div>
            <pre className="max-h-48 overflow-auto rounded bg-neutral-900 p-2 font-mono text-[10.5px] text-neutral-200">{info.log.join('\n') || '(empty)'}</pre>
          </div>
        )}
        <p className="text-neutral-500">Research PDFs, libraries and projects are stored locally. External AI is used only when explicitly enabled in Settings.</p>
      </div>
    </Modal>
  )
}
