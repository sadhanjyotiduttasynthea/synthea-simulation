import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useWs, type EquationEntry } from './wsStore'

/** Render page-specific settings into the right-hand Settings panel. */
export function Inspector({ children }: { children: ReactNode }) {
  const el = useWs((s) => s.inspectorEl)
  return el ? createPortal(children, el) : null
}

/** Render page-specific content into the bottom "Results" tab. */
export function ResultsSlot({ children }: { children: ReactNode }) {
  const el = useWs((s) => s.resultsEl)
  return el ? createPortal(children, el) : null
}

/** Render page-specific plots into the bottom "Plots" tab. */
export function PlotsSlot({ children }: { children: ReactNode }) {
  const el = useWs((s) => s.plotsEl)
  return el ? createPortal(children, el) : null
}

/** Publish the equations relevant to the current view to the bottom "Equations" tab. */
export function useEquations(eqs: EquationEntry[], deps: unknown[] = []) {
  const set = useWs((s) => s.setEquations)
  useEffect(() => {
    set(eqs)
    return () => set([])
  }, deps)  // eslint-disable-line react-hooks/exhaustive-deps
}
