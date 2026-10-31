import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { CompositionResult, FormLine } from './types'

/** Debounced server-side evaluation of a formulation (nutrition, cost, thermal). */
export function useEvaluation(lines: FormLine[] | undefined, serving = 30, temperature = 25, delay = 120) {
  const [result, setResult] = useState<CompositionResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const key = JSON.stringify(lines?.map((l) => [l.ingredient_id, l.percent])) + serving + ':' + temperature
  useEffect(() => {
    if (!lines || lines.length === 0) {
      setResult(null)
      return
    }
    const my = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      api
        .post<CompositionResult>('/api/formulations/evaluate', { lines, serving_size_g: serving, temperature_c: temperature })
        .then((r) => {
          if (my === seq.current) {
            setResult(r)
            setError(null)
          }
        })
        .catch((e) => my === seq.current && setError(e.message))
        .finally(() => my === seq.current && setLoading(false))
    }, delay)
    return () => clearTimeout(t)
  }, [key])  // eslint-disable-line react-hooks/exhaustive-deps
  return { result, loading, error }
}
