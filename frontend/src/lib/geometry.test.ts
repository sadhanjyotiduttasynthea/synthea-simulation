import { describe, expect, it } from 'vitest'
import { exportStl, measures, newObject, type GeoObject } from './geometry'

describe('geometry measures', () => {
  it('cuboid analytic volume and area, with scale', () => {
    const o = newObject('cuboid', 1)
    o.dims = { width: 60, depth: 20, height: 12 }
    expect(measures(o).volume).toBeCloseTo(14400, 9)
    expect(measures(o).area).toBeCloseTo(4320, 9)
    o.scale = [2, 1, 1]
    expect(measures(o).volume).toBeCloseTo(28800, 9)
  })
  it('cylinder and sphere', () => {
    const c = newObject('cylinder', 1)
    c.dims = { radius: 2, height: 20 }
    expect(measures(c).volume).toBeCloseTo(Math.PI * 4 * 20, 9)
    const s = newObject('sphere', 1)
    s.dims = { radius: 3 }
    expect(measures(s).area).toBeCloseTo(4 * Math.PI * 9, 9)
  })
  it('extrusion uses polygon area (shoelace)', () => {
    const e: GeoObject = { ...newObject('extrusion', 1), points: [[0, 0], [10, 0], [10, 5], [0, 5]], dims: { height: 4 } }
    expect(measures(e).volume).toBeCloseTo(200, 9)
    expect(measures(e).area).toBeCloseTo(2 * 50 + 30 * 4, 9)
  })
  it('STL export/import round trip preserves volume (mesh integration)', async () => {
    const o = newObject('cuboid', 1)
    o.dims = { width: 30, depth: 20, height: 10 }
    const blob = await exportStl([o])
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (const b of buf) s += String.fromCharCode(b)
    const stl: GeoObject = { ...newObject('stl', 2), stl_base64: btoa(s) }
    const m = measures(stl)
    expect(m.volume).toBeCloseTo(6000, 3)
    expect(m.area).toBeCloseTo(2 * (600 + 300 + 200), 3)
  })
})
