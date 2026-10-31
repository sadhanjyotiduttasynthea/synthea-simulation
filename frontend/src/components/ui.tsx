import { AlertTriangle, Info, Loader2, X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { useEffect, useState } from 'react'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
export function Button({ variant = 'secondary', size = 'md', loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  const v: Record<Variant, string> = {
    primary: 'bg-accent text-white hover:bg-accent-strong border-accent',
    secondary: 'bg-white text-neutral-800 border-neutral-300 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800',
    ghost: 'bg-transparent border-transparent text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800',
    danger: 'bg-white text-red-700 border-red-300 hover:bg-red-50 dark:bg-neutral-900 dark:border-red-900 dark:text-red-400',
  }
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm',
        v[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  )
}

export function Panel({ title, actions, children, className, bodyClass, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div className="min-w-0">
            <h3 className="truncate text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{title}</h3>
            {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cx('p-3', bodyClass)}>{children}</div>
    </section>
  )
}

const PROV_STYLE: Record<string, string> = {
  measured: 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900',
  literature: 'bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100',
  calculated: 'border border-neutral-400 text-neutral-700 dark:text-neutral-300',
  predicted: 'border border-dashed border-neutral-500 text-neutral-700 dark:text-neutral-300',
  illustrative: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  synthetic: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  synthetic_demo: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  missing: 'bg-white text-red-700 border border-red-300 dark:bg-transparent dark:text-red-400 dark:border-red-800',
}

export function Prov({ kind, className }: { kind?: string | null; className?: string }) {
  const k = kind || 'missing'
  return (
    <span className={cx('inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide', PROV_STYLE[k] ?? PROV_STYLE.calculated, className)}>
      {k === 'synthetic_demo' ? 'synthetic' : k}
    </span>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'red' | 'green' | 'amber' }) {
  const t = {
    neutral: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
    red: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  }[tone]
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', t)}>{children}</span>
}

export function Field({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-0.5 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[10px] text-neutral-400">{hint}</span>}
    </label>
  )
}

export const inputCls = 'h-7 rounded border border-neutral-300 bg-white px-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-neutral-300 dark:focus:ring-neutral-300'

const widthOr = (c?: string) => (c && /(^|\s)w-/.test(c) ? '' : 'w-full')

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(inputCls, widthOr(p.className), p.className)} />
}

export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(inputCls, 'pr-6', widthOr(p.className), p.className)} />
}

/** Numeric input that allows empty (null) and commits on blur/enter. */
export function NumInput({ value, onChange, step = 'any', min, max, placeholder, className, disabled, allowNull = true }: {
  value: number | null | undefined; onChange: (v: number | null) => void; step?: number | string; min?: number; max?: number; placeholder?: string; className?: string; disabled?: boolean; allowNull?: boolean
}) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value))
  useEffect(() => {
    setText(value === null || value === undefined ? '' : String(+value.toFixed(6)))
  }, [value])
  const commit = () => {
    if (text.trim() === '') {
      if (allowNull) onChange(null)
      else setText(value === null || value === undefined ? '' : String(value))
      return
    }
    const v = Number(text)
    if (Number.isNaN(v)) {
      setText(value === null || value === undefined ? '' : String(value))
      return
    }
    onChange(v)
  }
  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={cx(inputCls, 'num text-right', widthOr(className), className)}
    />
  )
}

export function Stat({ label, value, unit, sub, tone, prov }: { label: ReactNode; value: ReactNode; unit?: string; sub?: ReactNode; tone?: 'red' | 'default'; prov?: string }) {
  return (
    <div className="min-w-0 rounded border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-1">
        <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-neutral-500">{label}</div>
        {prov && <Prov kind={prov} />}
      </div>
      <div className={cx('num mt-0.5 text-lg font-semibold leading-tight', tone === 'red' && 'text-accent')}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-neutral-500">{unit}</span>}
      </div>
      {sub && <div className="truncate text-[11px] text-neutral-500">{sub}</div>}
    </div>
  )
}

export function Alert({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'error'; title?: ReactNode; children?: ReactNode }) {
  const s = {
    info: 'border-neutral-300 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    error: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  }[kind]
  const Icon = kind === 'info' ? Info : AlertTriangle
  return (
    <div className={cx('flex gap-2 rounded border px-3 py-2 text-xs', s)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  )
}

export function Spinner({ label = 'Computing…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <Loader2 className="h-4 w-4 animate-spin text-accent" />
      {label}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-0.5 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-1.5 text-xs font-medium',
            value === t.id ? 'border-accent text-neutral-900 dark:text-white' : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        className={cx('flex max-h-[90vh] w-full flex-col rounded border border-neutral-300 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900', wide ? 'max-w-4xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-900 dark:hover:text-white" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-neutral-200 px-4 py-2.5 dark:border-neutral-800">{footer}</div>}
      </div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-500 dark:border-neutral-700">{children}</div>
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  )
}

export function KV({ rows }: { rows: [ReactNode, ReactNode, ReactNode?][] }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map(([k, v, extra], i) => (
          <tr key={i} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
            <td className="py-1 pr-2 text-neutral-500">{k}</td>
            <td className="num py-1 text-right font-medium">{v}</td>
            {extra !== undefined && <td className="py-1 pl-2 text-right">{extra}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
