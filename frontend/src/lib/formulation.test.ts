import { describe, expect, it } from 'vitest'
import { addLine, normalise, removeLine, setPercent, total } from './formulation'
import { fmt } from './format'

const base = () => [
  { ingredient_id: 'a', percent: 20, locked: false },
  { ingredient_id: 'b', percent: 50, locked: false },
  { ingredient_id: 'c', percent: 30, locked: false },
]

describe('setPercent', () => {
  it('keeps total at 100 and scales others proportionally', () => {
    const r = setPercent(base(), 0, 40)
    expect(total(r.lines)).toBeCloseTo(100, 9)
    expect(r.lines[0].percent).toBe(40)
    expect(r.lines[1].percent / r.lines[2].percent).toBeCloseTo(50 / 30, 6)
  })
  it('respects locked lines', () => {
    const l = base()
    l[1].locked = true
    const r = setPercent(l, 0, 45)
    expect(r.lines[1].percent).toBe(50)
    expect(r.lines[2].percent).toBeCloseTo(5, 9)
    expect(total(r.lines)).toBeCloseTo(100, 9)
  })
  it('clamps to the maximum allowed by locked lines', () => {
    const l = base()
    l[1].locked = true
    const r = setPercent(l, 0, 80)
    expect(r.lines[0].percent).toBe(50)
    expect(r.message).toMatch(/Limited/)
  })
  it('reports infeasibility when nothing can rebalance', () => {
    const l = base()
    l[1].locked = true
    l[2].locked = true
    const r = setPercent(l, 0, 30)
    expect(r.feasible).toBe(false)
  })
})

describe('add/remove/normalise', () => {
  it('adds a line by taking mass from others', () => {
    const r = addLine(base(), 'd', 10)
    expect(r.lines).toHaveLength(4)
    expect(total(r.lines)).toBeCloseTo(100, 9)
  })
  it('removes a line and renormalises', () => {
    const r = removeLine(base(), 1)
    expect(total(r.lines)).toBeCloseTo(100, 9)
    expect(r.lines[0].percent / r.lines[1].percent).toBeCloseTo(20 / 30, 6)
  })
  it('normalise detects locked overflow', () => {
    const l = base().map((x) => ({ ...x, locked: true, percent: 60 }))
    expect(normalise(l).feasible).toBe(false)
  })
})

describe('fmt', () => {
  it('formats null as dash', () => {
    expect(fmt(null)).toBe('—')
    expect(fmt(1.23456, 2)).toBe('1.23')
  })
})
