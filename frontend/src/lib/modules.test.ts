import { describe, expect, it } from 'vitest'
import { MODULES, SHARED_PAGES, locate } from './modules'

describe('three-module navigation', () => {
  it('has exactly Synthea Materials, Process and Print', () => {
    expect(MODULES.map((m) => m.label)).toEqual(['Synthea Materials', 'Synthea Process', 'Synthea Print'])
    expect(MODULES.some((m) => /optimi[sz]e/i.test(m.label))).toBe(false)
  })
  it('places each page in the requested module', () => {
    const labels = (id: string) => MODULES.find((m) => m.id === id)!.pages.map((p) => p.label)
    expect(labels('materials')).toEqual(['Libraries', 'Papers', 'Extraction Review', 'Models', 'Materials', 'Formulation', 'Optimizer', 'Molecules'])
    expect(labels('process')).toEqual(['Process Simulator', 'Digital Twin'])
    expect(labels('print')).toEqual(['Geometry', '3D Printing Lab'])
    expect(SHARED_PAGES.map((p) => p.label)).toEqual(expect.arrayContaining(['Dashboard', 'Experiments', 'Reports', 'Settings']))
  })
  it('locates pages, including query-specific ones', () => {
    expect(locate('/optimizer', '').module?.id).toBe('materials')
    expect(locate('/papers', '?tab=review').page?.label).toBe('Extraction Review')
    expect(locate('/papers', '?paper=x').page?.label).toBe('Papers')
    expect(locate('/twin', '?twin=a').module?.id).toBe('process')
    expect(locate('/printing', '').module?.id).toBe('print')
    expect(locate('/reports', '').module).toBeNull()
  })
})
