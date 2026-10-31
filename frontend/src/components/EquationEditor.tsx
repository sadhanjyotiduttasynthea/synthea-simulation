import { useRef } from 'react'
import { Equation } from './Equation'
import { cx, inputCls } from './ui'

const PALETTE: [string, string][] = [
  ['τ', '\\tau'], ['τ₀', '\\tau_0'], ['γ̇', '\\dot{\\gamma}'], ['η', '\\eta'], ['μ', '\\mu'], ['ρ', '\\rho'], ['λ', '\\lambda'], ['α', '\\alpha'], ['β', '\\beta'],
  ['σ', '\\sigma'], ['ω', '\\omega'], ['θ', '\\theta'], ['Δ', '\\Delta'], ['∂', '\\partial'], ['∇', '\\nabla'], ['·', '\\cdot'], ['×', '\\times'], ['±', '\\pm'],
  ['xⁿ', '^{n}'], ['x₀', '_{0}'], ['a/b', '\\frac{a}{b}'], ['√', '\\sqrt{x}'], ['exp', '\\exp\\left(x\\right)'], ['ln', '\\ln'], ['°C', '^{\\circ}\\mathrm{C}'], ['s⁻¹', '\\mathrm{s}^{-1}'],
]

/** LaTeX equation editor with a symbol palette (Greek letters, sub/superscripts, units) and live KaTeX preview. */
export function EquationEditor({ value, onChange, rows = 2 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const insert = (s: string) => {
    const el = ref.current
    if (!el) return onChange(value + s)
    const a = el.selectionStart, b = el.selectionEnd
    const next = value.slice(0, a) + s + value.slice(b)
    onChange(next)
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = a + s.length })
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-0.5">
        {PALETTE.map(([label, tex]) => (
          <button key={label} type="button" title={tex} onClick={() => insert(tex)} className="h-6 min-w-6 rounded border border-neutral-300 px-1 text-[11px] hover:border-rose-500 hover:text-rose-600 dark:border-neutral-700">{label}</button>
        ))}
      </div>
      <textarea ref={ref} rows={rows} className={cx(inputCls, 'h-auto w-full py-1 font-mono text-[12px]')} value={value} onChange={(e) => onChange(e.target.value)} placeholder="LaTeX, e.g. \tau = \tau_0 + K\dot{\gamma}^{n}" />
      <div className="min-h-9 overflow-x-auto rounded border border-dashed border-cyan-500/50 bg-cyan-50/40 px-2 py-1.5 dark:bg-cyan-950/20">
        {value.trim() ? <Equation latex={value} display /> : <span className="text-[11px] text-neutral-400">preview</span>}
      </div>
    </div>
  )
}
