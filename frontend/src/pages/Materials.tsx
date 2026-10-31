import { Copy, Download, Plus, Save, Search, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Field, Input, NumInput, PageHeader, Panel, Prov, Select, Tabs, cx, inputCls } from '../components/ui'
import { api, download, readFile } from '../lib/api'
import { fmt, toCsv } from '../lib/format'
import type { Ingredient } from '../lib/types'
import { useStore } from '../store'

const PROV_OPTIONS = ['measured', 'literature', 'illustrative', 'missing']
const CATEGORIES = ['Protein', 'Starch', 'Hydrocolloid', 'Lipid', 'Solvent', 'Mineral', 'Fibre', 'Flavour', 'Other']

type NumFieldDef = [key: string, label: string, unit: string]
const NUTRITION: NumFieldDef[] = [
  ['protein', 'Protein', 'g/100 g'], ['carbohydrate', 'Carbohydrate (available)', 'g/100 g'], ['fat', 'Fat', 'g/100 g'],
  ['moisture', 'Moisture', 'g/100 g'], ['fibre', 'Dietary fibre', 'g/100 g'], ['ash', 'Ash', 'g/100 g'], ['sodium', 'Sodium', 'g/100 g'],
]
const PHYSICAL: NumFieldDef[] = [['density_kg_m3', 'Density', 'kg/m³'], ['solubility_pct', 'Solubility', '% w/w'], ['water_holding_capacity_g_g', 'Water-holding capacity', 'g/g']]
const RHEOLOGY: NumFieldDef[] = [
  ['viscosity_pa_s', 'Viscosity', 'Pa·s'], ['yield_stress_pa', 'Yield stress τ₀', 'Pa'], ['consistency_index_pa_sn', 'Consistency index K', 'Pa·sⁿ'],
  ['flow_behaviour_index', 'Flow behaviour index n', '–'], ['temperature_c', 'Measurement temperature', '°C'], ['shear_rate_1_s', 'Shear rate', '1/s'],
  ['concentration_pct', 'Concentration', '% w/w'], ['ph', 'pH', '–'],
]
const THERMAL: NumFieldDef[] = [['specific_heat_kj_kgk', 'Specific heat', 'kJ/(kg·K)'], ['conductivity_w_mk', 'Thermal conductivity', 'W/(m·K)']]

const blank = (): Ingredient => ({
  id: '', name: 'New ingredient', category: 'Other', supplier: '', source: '', version: 1, allergens: [], available: true,
  nutrition: Object.fromEntries(NUTRITION.map(([k]) => [k, null])),
  physical: Object.fromEntries(PHYSICAL.map(([k]) => [k, null])),
  rheology: Object.fromEntries(RHEOLOGY.map(([k]) => [k, null])),
  thermal: { specific_heat_kj_kgk: null, conductivity_w_mk: null, transition_temperatures: '' },
  economics: { price_per_kg: null, currency: 'EUR', supplier: '', date: new Date().toISOString().slice(0, 10), provenance: 'illustrative' },
  evidence: { references: [], measurement_conditions: '', uncertainty: '', validation_status: 'Not validated' },
  provenance: { nutrition: 'missing', physical: 'missing', rheology: 'missing', thermal: 'missing' },
})

type Tab = 'general' | 'nutrition' | 'physical' | 'rheology' | 'thermal' | 'economics' | 'evidence'

export default function Materials() {
  const { ingredients, refreshIngredients, toast, setAssistant } = useStore()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [selId, setSelId] = useState<string | null>(ingredients[0]?.id ?? null)
  const [draft, setDraft] = useState<Ingredient | null>(null)
  const [tab, setTab] = useState<Tab>('general')
  const [saving, setSaving] = useState(false)
  const isNew = draft !== null && !draft.id

  const sel = ingredients.find((i) => i.id === selId) ?? null
  useEffect(() => {
    if (!isNew) setDraft(sel ? structuredClone(sel) : null)
  }, [selId, sel?.updated_at])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setAssistant('materials', { ingredient: draft })
  }, [draft, setAssistant])

  const filtered = useMemo(
    () => ingredients.filter((i) => (!cat || i.category === cat) && (i.name.toLowerCase().includes(q.toLowerCase()) || i.category.toLowerCase().includes(q.toLowerCase()))),
    [ingredients, q, cat],
  )
  const dirty = draft && (isNew || JSON.stringify(draft) !== JSON.stringify(sel))

  const set = (path: string[], value: unknown) => {
    setDraft((d) => {
      if (!d) return d
      const c = structuredClone(d) as unknown as Record<string, unknown>
      let o = c
      for (const p of path.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>
      o[path[path.length - 1]] = value
      return c as unknown as Ingredient
    })
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = isNew ? await api.post<Ingredient>('/api/ingredients', draft) : await api.put<Ingredient>(`/api/ingredients/${draft.id}`, draft)
      await refreshIngredients()
      setSelId(saved.id)
      setDraft(saved)
      toast(`Saved ${saved.name} (version ${saved.version})`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!draft?.id || !confirm(`Delete ${draft.name}?`)) return
    try {
      await api.del(`/api/ingredients/${draft.id}`)
      await refreshIngredients()
      setSelId(null)
      setDraft(null)
      toast('Ingredient deleted', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const exportJson = () => download('synthea_ingredients.json', JSON.stringify(ingredients, null, 2))
  const exportCsv = () => {
    const head = ['id', 'name', 'category', 'supplier', 'allergens', ...NUTRITION.map((n) => n[0]), 'price_per_kg', 'currency', 'nutrition_provenance', 'validation_status']
    const rows = ingredients.map((i) => [i.id, i.name, i.category, i.supplier, i.allergens.join(';'), ...NUTRITION.map(([k]) => i.nutrition[k]), i.economics.price_per_kg, i.economics.currency, i.provenance.nutrition, i.evidence.validation_status])
    download('synthea_ingredients.csv', toCsv([head, ...rows]), 'text/csv')
  }
  const importJson = async () => {
    try {
      const txt = await readFile('.json')
      const data = JSON.parse(txt)
      const r = await api.post<{ imported: number }>('/api/ingredients/import', Array.isArray(data) ? data : [data])
      await refreshIngredients()
      toast(`Imported ${r.imported} ingredient(s)`, 'success')
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error')
    }
  }

  const numGrid = (section: 'nutrition' | 'physical' | 'rheology' | 'thermal', defs: NumFieldDef[]) => (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 @3xl:grid-cols-3">
      {defs.map(([k, label, unit]) => (
        <Field key={k} label={`${label} [${unit}]`}>
          <NumInput value={(draft![section] as Record<string, number | null>)[k] ?? null} onChange={(v) => set([section, k], v)} placeholder="missing" />
        </Field>
      ))}
    </div>
  )
  const provSelect = (section: string) => (
    <div className="mb-3 flex items-center gap-2 text-xs">
      <span className="text-neutral-500">Data provenance for this section:</span>
      <Select className="w-36" value={draft!.provenance?.[section] ?? 'missing'} onChange={(e) => set(['provenance', section], e.target.value)}>
        {PROV_OPTIONS.map((p) => <option key={p}>{p}</option>)}
      </Select>
      <Prov kind={draft!.provenance?.[section]} />
    </div>
  )

  const nutSum = draft ? ['protein', 'carbohydrate', 'fat', 'moisture', 'fibre', 'ash'].reduce((s, k) => s + (Number(draft.nutrition[k]) || 0), 0) : 0

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Materials Library"
        subtitle="Scientific ingredient database. Values marked ILLUSTRATIVE are demonstration placeholders and must be replaced by supplier or laboratory data."
        actions={
          <>
            <Button size="sm" onClick={() => { setSelId(null); setDraft(blank()); setTab('general') }}><Plus className="h-3.5 w-3.5" />New ingredient</Button>
            <Button size="sm" onClick={importJson}><Upload className="h-3.5 w-3.5" />Import JSON</Button>
            <Button size="sm" onClick={exportJson}><Download className="h-3.5 w-3.5" />Export JSON</Button>
            <Button size="sm" onClick={exportCsv}><Download className="h-3.5 w-3.5" />Export CSV</Button>
          </>
        }
      />
      <div className="grid min-h-0 flex-1 gap-3 @3xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)]">
        <Panel title={`Ingredients (${filtered.length})`} bodyClass="p-0" className="flex min-h-0 flex-col">
          <div className="flex gap-2 border-b border-neutral-200 p-2 dark:border-neutral-800">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1.5 h-4 w-4 text-neutral-400" />
              <input className={cx(inputCls, 'w-full pl-7')} placeholder="Search name or category" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select className="w-36" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-neutral-50 text-left text-[10px] uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
                <tr><th className="px-3 py-1.5">Name</th><th>Category</th><th className="text-right">Protein %</th><th className="text-right">Fat %</th><th className="text-right">€/kg</th><th className="px-2">Data</th></tr>
              </thead>
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id} onClick={() => setSelId(i.id)} className={cx('cursor-pointer border-t border-neutral-100 dark:border-neutral-800', i.id === selId ? 'bg-red-50/60 dark:bg-red-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50')}>
                    <td className="px-3 py-1.5 font-medium">{i.name}{!i.available && <Badge tone="amber">unavailable</Badge>}</td>
                    <td className="text-neutral-500">{i.category}</td>
                    <td className="num text-right">{fmt(i.nutrition.protein, 1)}</td>
                    <td className="num text-right">{fmt(i.nutrition.fat, 1)}</td>
                    <td className="num text-right">{fmt(i.economics.price_per_kg, 2)}</td>
                    <td className="px-2"><Prov kind={i.provenance?.nutrition} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title={draft ? `${isNew ? 'New ingredient' : draft.name}${draft.version ? ` · v${draft.version}` : ''}` : 'Ingredient record'}
          className="flex min-h-0 flex-col"
          bodyClass="min-h-0 flex-1 overflow-auto"
          actions={draft && (
            <>
              {!isNew && <Button size="sm" variant="ghost" onClick={() => { setSelId(null); setDraft({ ...structuredClone(draft), id: '', name: `${draft.name} (copy)`, version: 1 }) }}><Copy className="h-3.5 w-3.5" />Duplicate</Button>}
              {!isNew && <Button size="sm" variant="danger" onClick={remove}><Trash2 className="h-3.5 w-3.5" />Delete</Button>}
              <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={save}><Save className="h-3.5 w-3.5" />Save</Button>
            </>
          )}
        >
          {!draft ? <p className="text-xs text-neutral-500">Select an ingredient or create a new one.</p> : (
            <div className="space-y-3">
              <Tabs<Tab> value={tab} onChange={setTab} tabs={[
                { id: 'general', label: 'General' }, { id: 'nutrition', label: 'Nutrition' }, { id: 'physical', label: 'Physical' },
                { id: 'rheology', label: 'Rheology' }, { id: 'thermal', label: 'Thermal' }, { id: 'economics', label: 'Economics' }, { id: 'evidence', label: 'Evidence' },
              ]} />
              {tab === 'general' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name"><Input value={draft.name} onChange={(e) => set(['name'], e.target.value)} /></Field>
                  <Field label="Category"><Select value={draft.category} onChange={(e) => set(['category'], e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
                  <Field label="Supplier"><Input value={draft.supplier ?? ''} onChange={(e) => set(['supplier'], e.target.value)} /></Field>
                  <Field label="Source / origin"><Input value={draft.source ?? ''} onChange={(e) => set(['source'], e.target.value)} /></Field>
                  <Field label="Allergen tags (comma separated)" hint="Used by optimiser allergen restrictions"><Input value={draft.allergens.join(', ')} onChange={(e) => set(['allergens'], e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></Field>
                  <Field label="Availability">
                    <label className="flex h-7 items-center gap-2 text-sm"><input type="checkbox" checked={draft.available} onChange={(e) => set(['available'], e.target.checked)} /> Available for formulation / optimisation</label>
                  </Field>
                  <div className="col-span-2 text-[11px] text-neutral-500">Record version {draft.version ?? 1}; each save increments the version. Last updated: {draft.updated_at ? new Date(draft.updated_at).toLocaleString() : '—'}</div>
                </div>
              )}
              {tab === 'nutrition' && (
                <>
                  {provSelect('nutrition')}
                  {numGrid('nutrition', NUTRITION)}
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className={cx('rounded border px-2 py-1', Math.abs(nutSum - 100) > 2 ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30' : 'border-neutral-200 dark:border-neutral-700')}>Proximate sum: <b className="num">{fmt(nutSum, 1)} g/100 g</b> {Math.abs(nutSum - 100) > 2 && '(expected ≈ 100)'}</div>
                    <div className="rounded border border-neutral-200 px-2 py-1 dark:border-neutral-700">Energy (EU factors): <b className="num">{fmt(4 * (Number(draft.nutrition.protein) || 0) + 4 * (Number(draft.nutrition.carbohydrate) || 0) + 9 * (Number(draft.nutrition.fat) || 0) + 2 * (Number(draft.nutrition.fibre) || 0), 0)} kcal/100 g</b> <Prov kind="calculated" /></div>
                  </div>
                </>
              )}
              {tab === 'physical' && <>{provSelect('physical')}{numGrid('physical', PHYSICAL)}</>}
              {tab === 'rheology' && (
                <>
                  {provSelect('rheology')}
                  <Alert>Rheological parameters are only meaningful together with their measurement conditions (temperature, shear-rate range, concentration, pH). Ingredient rheology is <b>not</b> averaged into mixture rheology; measure formulation flow curves instead.</Alert>
                  <div className="mt-3">{numGrid('rheology', RHEOLOGY)}</div>
                </>
              )}
              {tab === 'thermal' && (
                <>
                  {provSelect('thermal')}
                  {numGrid('thermal', THERMAL)}
                  <Field className="mt-3" label="Relevant transition temperatures (denaturation, gelatinisation, melting) and method"><textarea className={cx(inputCls, 'h-16 w-full py-1')} value={String(draft.thermal.transition_temperatures ?? '')} onChange={(e) => set(['thermal', 'transition_temperatures'], e.target.value)} /></Field>
                </>
              )}
              {tab === 'economics' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Price per kg"><NumInput value={draft.economics.price_per_kg} onChange={(v) => set(['economics', 'price_per_kg'], v)} placeholder="missing" /></Field>
                  <Field label="Currency"><Input value={draft.economics.currency ?? 'EUR'} onChange={(e) => set(['economics', 'currency'], e.target.value)} /></Field>
                  <Field label="Price source / supplier"><Input value={draft.economics.supplier ?? ''} onChange={(e) => set(['economics', 'supplier'], e.target.value)} /></Field>
                  <Field label="Price date"><Input type="date" value={draft.economics.date ?? ''} onChange={(e) => set(['economics', 'date'], e.target.value)} /></Field>
                  <Field label="Price provenance"><Select value={draft.economics.provenance ?? 'illustrative'} onChange={(e) => set(['economics', 'provenance'], e.target.value)}>{['quotation', 'invoice', 'literature', 'illustrative'].map((p) => <option key={p}>{p}</option>)}</Select></Field>
                  {draft.economics.provenance === 'illustrative' && <div className="col-span-2"><Alert kind="warn">This price is an illustrative placeholder, not a market quotation. Cost results inherit this limitation.</Alert></div>}
                </div>
              )}
              {tab === 'evidence' && (
                <div className="space-y-3">
                  <Field label="Literature references (one per line)" hint="Enter only references you have verified."><textarea className={cx(inputCls, 'h-20 w-full py-1')} value={draft.evidence.references.join('\n')} onChange={(e) => set(['evidence', 'references'], e.target.value.split('\n').filter((s) => s.trim()))} /></Field>
                  <Field label="Measurement conditions"><Input value={draft.evidence.measurement_conditions ?? ''} onChange={(e) => set(['evidence', 'measurement_conditions'], e.target.value)} /></Field>
                  <Field label="Uncertainty"><Input value={draft.evidence.uncertainty ?? ''} onChange={(e) => set(['evidence', 'uncertainty'], e.target.value)} /></Field>
                  <Field label="Validation status"><Input value={draft.evidence.validation_status ?? ''} onChange={(e) => set(['evidence', 'validation_status'], e.target.value)} /></Field>
                  <div className="flex flex-wrap gap-2 text-xs">{Object.entries(draft.provenance ?? {}).map(([k, v]) => <span key={k} className="flex items-center gap-1">{k}: <Prov kind={v} /></span>)}</div>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
