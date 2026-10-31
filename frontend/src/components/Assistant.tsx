import { Bot, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import { Badge, Spinner } from './ui'

interface Msg { role: 'user' | 'assistant'; text: string; mode?: string; note?: string }

const SUGGESTIONS = ['Explain these results', 'What data is missing?', 'Explain the optimisation trade-offs', 'Suggest an experimental plan']

export function Assistant({ embedded = false }: { embedded?: boolean }) {
  const { assistantPage, assistantContext, openAssistant } = useStore()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ mode: string; model?: string } | null>(null)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.get<{ mode: string; model?: string }>('/api/assistant/status').then(setStatus).catch(() => setStatus(null))
  }, [])
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, busy])

  const ask = async (question: string) => {
    if (!question.trim()) return
    setMsgs((m) => [...m, { role: 'user', text: question }])
    setQ('')
    setBusy(true)
    try {
      const r = await api.post<{ answer: string; mode: string; note?: string }>('/api/assistant', { question, page: assistantPage, context: assistantContext })
      setMsgs((m) => [...m, { role: 'assistant', text: r.answer, mode: r.mode, note: r.note }])
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: `Error: ${(e as Error).message}` }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className={embedded ? 'flex h-full min-h-0 flex-col bg-white dark:bg-neutral-900' : 'flex w-[360px] shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'}>
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <Bot className="h-4 w-4 text-accent" />
        <div className="flex-1">
          <div className="text-sm font-semibold">Scientific assistant</div>
          <div className="text-[10px] text-neutral-500">
            Context: <b>{assistantPage}</b> · {status?.mode === 'claude' ? `Claude (${status.model})` : 'built-in explainer (no external AI)'}
          </div>
        </div>
        {!embedded && <button onClick={() => openAssistant(false)} aria-label="Close assistant"><X className="h-4 w-4 text-neutral-500" /></button>}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {msgs.length === 0 && (
          <div className="space-y-2 text-neutral-500">
            <p>Ask about the results on the current page. Numerical values are taken only from the computation engine; the assistant does not generate numbers.</p>
            <div className="flex flex-wrap gap-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => ask(s)} className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'ml-8 rounded bg-neutral-900 px-3 py-2 text-white dark:bg-neutral-700' : 'mr-2 rounded border border-neutral-200 px-3 py-2 dark:border-neutral-700'}>
            <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
            {m.role === 'assistant' && m.mode && (
              <div className="mt-1.5 flex gap-1"><Badge>{m.mode === 'claude' ? 'Claude' : 'built-in'}</Badge>{m.note && <Badge tone="amber">{m.note}</Badge>}</div>
            )}
          </div>
        ))}
        {busy && <Spinner label="Thinking…" />}
        <div ref={end} />
      </div>
      <form
        className="flex gap-1 border-t border-neutral-200 p-2 dark:border-neutral-800"
        onSubmit={(e) => {
          e.preventDefault()
          ask(q)
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about these results…"
          className="h-8 flex-1 rounded border border-neutral-300 bg-white px-2 text-xs dark:border-neutral-700 dark:bg-neutral-950"
        />
        <button type="submit" disabled={busy} className="flex h-8 w-8 items-center justify-center rounded bg-accent text-white disabled:opacity-50" aria-label="Send"><Send className="h-3.5 w-3.5" /></button>
      </form>
    </aside>
  )
}
