export type Provenance = 'measured' | 'literature' | 'calculated' | 'predicted' | 'illustrative' | 'synthetic' | 'missing' | string

export interface Ingredient {
  id: string
  name: string
  category: string
  supplier?: string
  source?: string
  version?: number
  allergens: string[]
  available: boolean
  nutrition: Record<string, number | null>
  physical: Record<string, number | null>
  rheology: Record<string, number | null>
  thermal: Record<string, number | string | null>
  economics: { price_per_kg: number | null; currency?: string; supplier?: string; date?: string; provenance?: string }
  evidence: { references: string[]; measurement_conditions?: string; uncertainty?: string; validation_status?: string }
  provenance: Record<string, Provenance>
  updated_at?: string
}

export interface FormLine { ingredient_id: string; percent: number; locked?: boolean }

export interface Rheology {
  yield_stress_pa: number | null
  consistency_index_pa_sn: number | null
  flow_behaviour_index: number | null
  temperature_c?: number | null
  source?: string
  data_type?: Provenance
}

export interface Formulation {
  id: string
  project_id: string
  name: string
  origin?: string
  lines: FormLine[]
  notes?: string
  rheology?: Rheology | null
  updated_at?: string
}

export interface ProjectSettings { serving_size_g: number; currency: string; energy_price_eur_kwh: number }

export interface OptimizerSettings {
  min_protein: number | null
  max_cost: number | null
  bounds: Record<string, [number | null, number | null]>
  nutrient_limits: Record<string, [number | null, number | null]>
  excluded_allergens?: string[]
  ingredient_ids?: string[]
  processing?: { response: string; lower: number | null; upper: number | null } | null
}

export interface Project {
  id: string
  name: string
  description?: string
  created?: string
  active_formulation_id?: string | null
  settings: ProjectSettings
  optimizer: OptimizerSettings
  print_settings?: Record<string, unknown> | null
  updated_at?: string
}

export interface CompositionResult {
  total_percent: number
  composition: Record<string, number>
  energy_kcal_100g: number
  energy_kj_100g: number
  cost_per_kg: number | null
  cost_breakdown: { ingredient: string; percent: number; price_per_kg: number | null; contribution: number | null; share?: number }[]
  cost_per_serving: number | null
  cost_per_g_protein: number | null
  warnings: string[]
  missing_data: string[]
  salt_equivalent_g_100g?: number
  thermal?: { density_kg_m3: number; specific_heat_kj_kgk: number; conductivity_w_mk: number; thermal_diffusivity_m2_s: number; model: string; warnings: string[]; temperature_c: number } | null
  predictive_models?: Record<string, string>
  provenance?: string[]
}

export interface Constraint { constraint: string; kind: string; value: number; limit: number; satisfied: boolean; binding: boolean }

export interface Candidate extends Partial<CompositionResult> {
  label: string
  mode: string
  rationale: string
  status?: string
  message?: string
  constraints?: Constraint[]
  all_satisfied?: boolean
  formulation?: { ingredient_id: string; name: string; percent: number }[]
  sensitivities?: { constraint: string; sensitivity: number; text: string }[]
  uncertainty?: { assumptions: string; protein_p05: number; protein_p95: number; cost_p05: number; cost_p95: number; p_protein_ok?: number; p_cost_ok?: number }
  prediction?: { value: number; band_low: number; band_high: number; target_low: number | null; target_high: number | null; novelty: number }
  model?: { kernel: string; n_training: number; data_types: string[]; response_label: string; unit: string }
  cv?: { q2: number; rmse_transformed: number; n: number; space: string }
  model_warnings?: string[]
  response_label?: string
  unit?: string
}

export interface OptimizationResult {
  status: 'optimal' | 'infeasible' | 'error'
  message?: string
  method: string
  limitations: string[]
  ingredients: { id: string; name: string }[]
  excluded: { id: string; name: string; reason: string }[]
  baseline?: Candidate
  candidates: Candidate[]
  pareto: { protein: number; cost: number; x: number[]; within_budget: boolean }[]
  infeasibility?: { reasons: string[]; relaxations: { constraint: string; current: number; required: number; text: string }[]; suggestions: string[] }
}

export interface Experiment {
  id: string
  project_id: string
  name: string
  date?: string | null
  data_type: Provenance
  composition: Record<string, number>
  process: Record<string, number | null>
  measurements: Record<string, number | string | null>
  cost_eur?: number | null
  notes?: string
}
