export function fmt(v: number | null | undefined, d = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (!Number.isFinite(v)) return '∞'
  return v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export const eur = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : `€${fmt(v, d)}`)
export const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : `${fmt(v, d)} %`)

export function fmtSci(v: number | null | undefined, d = 3): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v === 0) return '0'
  if (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5) return v.toExponential(Math.max(d - 1, 1)).replace(/\.?0+e/, 'e')
  const s = Number(v.toPrecision(Math.max(d, 1)))
  return s.toLocaleString('en-GB', { maximumFractionDigits: 6 })
}

export const NUTRIENT_LABELS: Record<string, string> = {
  protein: 'Protein',
  carbohydrate: 'Carbohydrate',
  fat: 'Fat',
  moisture: 'Moisture',
  fibre: 'Fibre',
  ash: 'Ash',
  sodium: 'Sodium',
}

export const SERIES = ['#b91c1c', '#262626', '#737373', '#ef4444', '#a3a3a3', '#7f1d1d', '#d4d4d4', '#525252', '#fca5a5']

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) => r.map((c) => {
      const s = c === null || c === undefined ? '' : String(c)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(','))
    .join('\n')
}
