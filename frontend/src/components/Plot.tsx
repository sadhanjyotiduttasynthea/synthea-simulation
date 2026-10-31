import { useEffect, useRef, useState } from 'react'
import type { Config, Data, Layout } from 'plotly.js-dist-min'
import { useStore } from '../store'

type PlotlyLib = typeof import('plotly.js-dist-min')
let plotlyPromise: Promise<PlotlyLib> | null = null
const loadPlotly = () => (plotlyPromise ??= import('plotly.js-dist-min').then((m) => (m as unknown as { default?: PlotlyLib }).default ?? (m as unknown as PlotlyLib)))

/** Thin Plotly wrapper (lazy-loaded) with the workstation theme, legends, units and PNG/SVG export. */
export function Plot({ data, layout, height = 300, className, config }: { data: Data[]; layout?: Partial<Layout>; height?: number; className?: string; config?: Partial<Config> }) {
  const ref = useRef<HTMLDivElement>(null)
  const dark = useStore((s) => s.dark)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    loadPlotly().then((P) => {
      if (!alive || !ref.current) return
      const fg = dark ? '#d4d4d4' : '#262626'
      const grid = dark ? '#2b2f36' : '#e5e7eb'
      const base: Partial<Layout> = {
        height, margin: { l: 56, r: 16, t: 28, b: 64 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: { family: 'Inter, system-ui, sans-serif', size: 11, color: fg },
        colorway: ['#e11d48', '#0891b2', '#525252', '#f59e0b', '#7c3aed', '#16a34a', '#be185d', '#0e7490'],
        legend: { orientation: 'h', y: -0.32, yanchor: 'top', font: { size: 10 } },
        ...layout,
      }
      for (const ax of ['xaxis', 'yaxis', 'xaxis2', 'yaxis2'] as const) {
        const a = (layout?.[ax] ?? (ax.endsWith('2') ? undefined : {})) as Record<string, unknown> | undefined
        if (a) (base as Record<string, unknown>)[ax] = { gridcolor: grid, zerolinecolor: grid, linecolor: grid, ...a }
      }
      P.react(ref.current, data, base, { displaylogo: false, responsive: true, toImageButtonOptions: { format: 'png', scale: 2 }, modeBarButtonsToRemove: ['lasso2d', 'select2d'], ...config })
        .catch((e: Error) => setErr(e.message))
    })
    return () => { alive = false }
  }, [data, layout, height, dark, config])
  useEffect(() => () => { const el = ref.current; if (el) loadPlotly().then((P) => P.purge(el)) }, [])
  return <div className={className}>{err ? <div className="text-xs text-red-600">Plot error: {err}</div> : <div ref={ref} style={{ height }} />}</div>
}
