import { Atom, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import type { FormLine } from '../lib/types'
import { Alert, Badge, NumInput, Panel, Prov, Spinner, Tabs, cx } from './ui'

interface Basis { kind: string; record_id?: string; material?: string; label?: string; value?: number | null; value_text?: string; unit?: string; paper_id?: string; page?: number; paper?: string; citation?: string; synthetic?: boolean; status?: string; rule?: string; detail?: string; provenance?: string | string[]; field?: string }
interface Statement { attribute: string; text: string; label: string; basis: Basis[]; needs: string[]; uncertainty?: number | null; assumptions: string[] }
interface Profile { attributes: Record<string, Statement[]>; note: string; process_temperature?: { value: number; source: string; provenance: string } | null }
interface Scene { scene_id: string; computed: boolean; label: string; interaction_energy_kcal_mol?: number; hydrogen_bonds?: number }
interface Inter { a: string; b: string; mechanism: string; rating: 'compatible' | 'caution' | 'incompatible' | 'unknown'; basis_type: string; basis: Basis[]; needs: string[]; scenes: Scene[] }

const ATTR: [string, string][] = [['aroma', 'Aroma'], ['flavour', 'Flavour (incl. beany notes)'], ['colour', 'Colour'], ['mouthfeel', 'Mouthfeel'], ['texture', 'Expected texture'], ['technical', 'Technical']]
const LABEL_PROV: Record<string, string> = { not_predicted: 'missing' }
const RATING: Record<string, string> = {
  compatible: 'bg-emerald-600 text-white', caution: 'bg-amber-500 text-white', incompatible: 'bg-red-600 text-white', unknown: 'bg-neutral-300 text-neutral-800 dark:bg-white/15 dark:text-neutral-200',
}

function BasisList({ basis }: { basis: Basis[] }) {
  if (!basis.length) return null
  return (
    <ul className="mt-0.5 space-y-0.5 text-[10.5px] text-neutral-500">
      {basis.map((b, i) => (
        <li key={i}>
          {b.kind === 'record' && <>
            {b.paper_id ? <Link className="inline-flex items-center gap-0.5 text-rose-600 underline" to={`/papers?paper=${b.paper_id}&tab=review`}>{b.paper ?? 'paper'}{b.page ? `, p. ${b.page}` : ''}<ExternalLink className="h-2.5 w-2.5" /></Link> : <span>{b.citation ?? 'record'}</span>}
            {' '}· {b.material} · {b.label} {b.value_text ?? (b.value != null ? `${+Number(b.value).toPrecision(4)} ${b.unit ?? ''}` : '')} · <Badge tone="green">{b.status}</Badge>
            {b.synthetic && <span className="ml-1 rounded bg-red-600 px-1 text-[9px] text-white">SYNTHETIC</span>}
          </>}
          {b.kind === 'rule' && <span>Documented rule {b.rule}{b.detail ? `: ${b.detail}` : ''} (SCIENTIFIC_MODELS.md)</span>}
          {b.kind === 'ingredient_table' && <span>Ingredient table values ({Array.isArray(b.provenance) ? b.provenance.join(', ') : b.provenance})</span>}
          {b.kind === 'ingredient' && <span>Ingredient field {b.field} ({String(b.provenance)})</span>}
          {b.kind === 'formulation_rheology' && <span>Formulation rheology record ({String(b.provenance)})</span>}
        </li>
      ))}
    </ul>
  )
}

/** Sensory & technical profile and ingredient interaction panel for the current formulation. */
export function FormulationInsights({ lines, formulationId, projectId }: { lines: FormLine[]; formulationId?: string; projectId?: string }) {
  type T = 'profile' | 'interactions'
  const [tab, setTab] = useState<T>('profile')
  const [ph, setPh] = useState<number | null>(null)
  const [temp, setTemp] = useState<number | null>(null)
  const [prof, setProf] = useState<Profile | null>(null)
  const [inter, setInter] = useState<{ interactions: Inter[]; note: string; process_temperature?: Profile['process_temperature'] } | null>(null)
  const [busy, setBusy] = useState(false)
  const key = JSON.stringify(lines)
  useEffect(() => {
    let alive = true
    setBusy(true)
    const body = { lines, formulation_id: formulationId, project_id: projectId, ph, process_temperature_c: temp }
    Promise.all([api.post<Profile>('/api/formulations/profile', body), api.post<typeof inter>('/api/formulations/interactions', body)])
      .then(([p, i]) => { if (alive) { setProf(p); setInter(i) } }).finally(() => alive && setBusy(false))
    return () => { alive = false }
  }, [key, ph, temp, formulationId, projectId])  // eslint-disable-line react-hooks/exhaustive-deps
  const T_src = prof?.process_temperature
  return (
    <Panel title="Virtual formulation insights" subtitle="Sensory & technical profile and ingredient interactions — every statement shows its basis; gaps say which data would fill them.">
      <div className="mb-2 flex flex-wrap items-end gap-3 text-xs">
        <Tabs<T> value={tab} onChange={setTab} tabs={[{ id: 'profile', label: 'Sensory & technical profile' }, { id: 'interactions', label: `Interactions${inter ? ` (${inter.interactions.length})` : ''}` }]} />
        <label className="flex items-center gap-1">Formulation pH <NumInput value={ph} onChange={setPh} placeholder="missing" className="w-20" /></label>
        <label className="flex items-center gap-1">Process temperature [°C] <NumInput value={temp} onChange={setTemp} placeholder={T_src ? String(T_src.value) : 'missing'} className="w-20" /></label>
        {T_src && <span className="text-[10.5px] text-neutral-500">using {T_src.value} °C — {T_src.source} <Prov kind={T_src.provenance} /></span>}
        {busy && <Spinner label="Evaluating…" />}
      </div>
      {tab === 'profile' && prof && (
        <div className="grid gap-2 @3xl:grid-cols-2">
          {ATTR.map(([k, label]) => (
            <div key={k} className="rounded border border-neutral-200 p-2 dark:border-white/10">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{label}</div>
              <ul className="space-y-1.5 text-xs">
                {(prof.attributes[k] ?? []).map((s, i) => (
                  <li key={i} className={cx(s.label === 'not_predicted' && 'text-neutral-500')}>
                    <div className="flex items-start gap-1.5"><Prov kind={LABEL_PROV[s.label] ?? s.label} /><span className="flex-1">{s.text}</span></div>
                    {s.assumptions.length > 0 && <div className="pl-1 text-[10.5px] italic text-neutral-500">Assumes: {s.assumptions.join('; ')}</div>}
                    <BasisList basis={s.basis} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[10.5px] text-neutral-500 @3xl:col-span-2">{prof.note}</p>
        </div>
      )}
      {tab === 'interactions' && inter && (
        <div className="space-y-1.5 text-xs">
          {inter.interactions.map((x, i) => (
            <div key={i} className="grid gap-2 rounded border border-neutral-200 p-2 @3xl:grid-cols-[220px_110px_1fr] dark:border-white/10">
              <div><b>{x.a}</b> + <b>{x.b}</b><div className="text-[10.5px] text-neutral-500">{x.mechanism}</div></div>
              <div><span className={cx('rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase', RATING[x.rating])}>{x.rating}</span><div className="mt-0.5 text-[10px] text-neutral-500">{x.basis_type}</div></div>
              <div>
                <BasisList basis={x.basis} />
                {x.needs.length > 0 && <div className="text-[10.5px] text-amber-700 dark:text-amber-400">Needs: {x.needs.join('; ')}</div>}
                {x.scenes.map((s) => (
                  <Link key={s.scene_id} to="/molecules?mode=interaction" className="mt-0.5 flex items-center gap-1 text-[10.5px] text-cyan-700 underline dark:text-cyan-400">
                    <Atom className="h-3 w-3" />Molecules scene: {s.computed ? `E_int ${s.interaction_energy_kcal_mol?.toFixed(2)} kcal/mol, ${s.hydrogen_bonds} H-bond(s) — force field, vacuum (context, not a compatibility measure)` : 'conceptual'}
                  </Link>
                ))}
              </div>
            </div>
          ))}
          <Alert>{inter.note}</Alert>
        </div>
      )}
    </Panel>
  )
}
