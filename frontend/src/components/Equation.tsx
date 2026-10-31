import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useMemo } from 'react'

/** Render a LaTeX expression with KaTeX. Invalid LaTeX is shown as source text with an error marker. */
export function Equation({ latex, display = false, className }: { latex: string; display?: boolean; className?: string }) {
  const html = useMemo(() => {
    try {
      return { ok: true, html: katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false }) }
    } catch (e) {
      return { ok: false, html: (e as Error).message }
    }
  }, [latex, display])
  if (!html.ok) {
    return (
      <span className={className} title={html.html}>
        <code className="rounded bg-red-50 px-1 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300">{latex}</code>
      </span>
    )
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: html.html }} />
}
