import type { FormLine } from './types'

export const EPS = 1e-9

export const total = (lines: FormLine[]) => lines.reduce((s, l) => s + (Number(l.percent) || 0), 0)

const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d

export interface RebalanceResult { lines: FormLine[]; feasible: boolean; message?: string }

/**
 * Set one line's percentage and rebalance the *unlocked* other lines so that the
 * total stays 100 %. Unlocked lines are scaled in proportion to their current
 * values (equal split if they are all zero). The edited value is clamped to what
 * is achievable given locked lines.
 */
export function setPercent(lines: FormLine[], index: number, value: number): RebalanceResult {
  const out = lines.map((l) => ({ ...l }))
  const lockedSum = out.reduce((s, l, i) => (i !== index && l.locked ? s + l.percent : s), 0)
  const free = out.map((l, i) => (i !== index && !l.locked ? i : -1)).filter((i) => i >= 0)
  const maxVal = Math.max(0, 100 - lockedSum)
  let v = Math.min(Math.max(value, 0), 100)
  if (free.length === 0) {
    out[index].percent = round(v)
    const t = total(out)
    return { lines: out, feasible: Math.abs(t - 100) < 1e-6, message: Math.abs(t - 100) < 1e-6 ? undefined : `No unlocked ingredients to rebalance: total is ${t.toFixed(2)} %. Unlock an ingredient.` }
  }
  let message: string | undefined
  if (v > maxVal) {
    message = `Limited to ${maxVal.toFixed(2)} % by locked ingredients.`
    v = maxVal
  }
  out[index].percent = round(v)
  const remaining = 100 - lockedSum - v
  const freeSum = free.reduce((s, i) => s + out[i].percent, 0)
  for (const i of free) {
    out[i].percent = round(freeSum > EPS ? (out[i].percent / freeSum) * remaining : remaining / free.length)
  }
  // fix rounding drift on the largest free line
  const drift = 100 - total(out)
  if (Math.abs(drift) > 0) {
    const big = free.reduce((a, b) => (out[b].percent > out[a].percent ? b : a), free[0])
    out[big].percent = round(Math.max(0, out[big].percent + drift))
  }
  return { lines: out, feasible: true, message }
}

/** Scale unlocked lines so the total is exactly 100 %. */
export function normalise(lines: FormLine[]): RebalanceResult {
  const out = lines.map((l) => ({ ...l }))
  const lockedSum = out.reduce((s, l) => (l.locked ? s + l.percent : s), 0)
  const free = out.map((l, i) => (!l.locked ? i : -1)).filter((i) => i >= 0)
  if (lockedSum > 100 + 1e-9) return { lines: out, feasible: false, message: 'Locked ingredients exceed 100 %.' }
  if (free.length === 0) return { lines: out, feasible: Math.abs(lockedSum - 100) < 1e-6, message: 'All ingredients are locked.' }
  const freeSum = free.reduce((s, i) => s + out[i].percent, 0)
  const remaining = 100 - lockedSum
  for (const i of free) out[i].percent = round(freeSum > EPS ? (out[i].percent / freeSum) * remaining : remaining / free.length)
  const drift = 100 - total(out)
  const big = free.reduce((a, b) => (out[b].percent > out[a].percent ? b : a), free[0])
  out[big].percent = round(out[big].percent + drift)
  return { lines: out, feasible: true }
}

/** Add an ingredient at a given percentage, taking the mass from unlocked lines. */
export function addLine(lines: FormLine[], ingredient_id: string, percent = 0): RebalanceResult {
  if (lines.some((l) => l.ingredient_id === ingredient_id)) return { lines, feasible: true, message: 'Ingredient already in formulation.' }
  const next = [...lines.map((l) => ({ ...l })), { ingredient_id, percent: 0, locked: false }]
  if (lines.length === 0) {
    next[0].percent = 100
    return { lines: next, feasible: true }
  }
  return setPercent(next, next.length - 1, percent)
}

export function removeLine(lines: FormLine[], index: number): RebalanceResult {
  const next = lines.filter((_, i) => i !== index).map((l) => ({ ...l }))
  if (next.length === 0) return { lines: next, feasible: false }
  return normalise(next)
}
