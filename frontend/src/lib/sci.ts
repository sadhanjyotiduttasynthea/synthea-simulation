import { useEffect, useState } from 'react'
import { api } from './api'

export interface Library { id: string; name: string; description?: string; folders: { id: string; name: string }[]; tags: string[]; archived?: boolean; version?: number; material_count?: number }
export interface Material {
  id: string; name: string; category: string; library_ids: string[]; folders?: Record<string, string>; tags: string[]; synonyms: string[]
  identity?: Record<string, string | undefined>; ingredient_id?: string; version?: number; previous_version_id?: string; archived?: boolean
  history?: { t: string; note: string }[]; library_names?: string[]; property_count?: number; approved_count?: number; pending_count?: number
}
export interface Source { paper_id?: string; page?: number; snippet?: string; table_ref?: string; citation?: string; extraction_id?: string }
export interface PropertyRecord {
  id: string; material_id: string; property: string; label?: string; category?: string
  value: number | null; value_max?: number | null; value_text?: string; unit?: string
  normalized?: { value: number | null; unit: string; ok: boolean; note: string | null } | null
  uncertainty?: { type?: string; value?: number | null; text?: string }; n?: number | null
  conditions: Record<string, number | string | null>; composition?: string; method?: string
  source: Source; evidence_type: string; review_status: string; confidence?: string; notes?: string
  quality?: { score: number; flags: string[] }; history?: { t: string; note: string; changed?: string[] }[]; version?: number
  model_id?: string
}
export interface Catalog {
  categories: Record<string, string>
  properties: { key: string; label: string; category: string; unit: string | null; aliases: string[] }[]
  conditions: { key: string; label: string; unit: string | null }[]
  evidence_types: Record<string, string>
  review_statuses: string[]
}

let catalogCache: Catalog | null = null
export function useCatalog() {
  const [c, setC] = useState<Catalog | null>(catalogCache)
  useEffect(() => {
    if (!catalogCache) api.get<Catalog>('/api/catalog').then((r) => { catalogCache = r; setC(r) })
  }, [])
  return c
}

export const STATUS_STYLE: Record<string, string> = {
  extracted: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  pending: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  reviewed: 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
  validated: 'bg-emerald-600 text-white',
  rejected: 'bg-neutral-200 text-neutral-500 line-through dark:bg-neutral-800',
  deprecated: 'bg-neutral-200 text-neutral-500 dark:bg-neutral-800',
}

export const unitLabel = (u?: string | null) => (u ?? '').replace(/\*\*2/g, '²').replace(/\*\*3/g, '³').replace(/\*\*n/g, 'ⁿ').replace(/\*/g, '·').replace('degC', '°C').replace('percent', '%').replace('micrometer', 'µm')

export const condText = (c: Record<string, number | string | null> | undefined, labels?: Record<string, { label: string; unit: string | null }>) =>
  Object.entries(c ?? {}).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${labels?.[k]?.label ?? k} ${v}${labels?.[k]?.unit ? ' ' + unitLabel(labels[k].unit) : ''}`).join(' · ')
