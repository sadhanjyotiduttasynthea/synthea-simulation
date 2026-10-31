import { Check, Plus, Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Catalog, type PropertyRecord, STATUS_STYLE, unitLabel } from '../lib/sci'
import { Button, Field, Input, NumInput, Select, cx, inputCls } from './ui'

/** Editor for one condition-aware property record (used in the library and in extraction review). */
export function PropertyEditor({ record, catalog, papers, onSave, onDelete, onCancel, compact }: {
  record: PropertyRecord; catalog: Catalog; papers?: { id: string; title: string }[]
  onSave: (r: PropertyRecord) => void | Promise<void>; onDelete?: () => void; onCancel?: () => void; compact?: boolean
}) {
  const [r, setR] = useState<PropertyRecord>(record)
  useEffect(() => setR(record), [record])
  const meta = catalog.properties.find((p) => p.key === r.property)
  const set = <K extends keyof PropertyRecord>(k: K, v: PropertyRecord[K]) => setR({ ...r, [k]: v })
  const condLabels = Object.fromEntries(catalog.conditions.map((c) => [c.key, c]))
  const unusedConds = catalog.conditions.filter((c) => !(c.key in (r.conditions ?? {})))
  const grouped = Object.entries(catalog.categories).map(([cat, label]) => ({ cat, label, items: catalog.properties.filter((p) => p.category === cat) }))

  return (
    <div className="space-y-2 text-xs">
      <Field label="Property">
        <Select value={r.property} onChange={(e) => setR({ ...r, property: e.target.value, unit: r.unit || catalog.properties.find((p) => p.key === e.target.value)?.unit?.replace('**', '^') || '' })}>
          {grouped.map((g) => <optgroup key={g.cat} label={g.label}>{g.items.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</optgroup>)}
          {!meta && <option value={r.property}>{r.property} (custom)</option>}
        </Select>
      </Field>
      <div className="grid grid-cols-3 gap-1.5">
        <Field label="Value"><NumInput value={r.value} onChange={(v) => set('value', v)} /></Field>
        <Field label="to (range)"><NumInput value={r.value_max ?? null} onChange={(v) => set('value_max', v)} placeholder="–" /></Field>
        <Field label={`Unit${meta?.unit ? ` (→ ${unitLabel(meta.unit)})` : ''}`}><Input className="w-full" value={r.unit ?? ''} onChange={(e) => set('unit', e.target.value)} /></Field>
      </div>
      <Field label="Text value (non-numeric findings, e.g. 'shear-thinning')"><Input className="w-full" value={r.value_text ?? ''} onChange={(e) => set('value_text', e.target.value)} /></Field>
      <div className="grid grid-cols-3 gap-1.5">
        <Field label="Uncertainty"><NumInput value={r.uncertainty?.value ?? null} onChange={(v) => set('uncertainty', { ...r.uncertainty, value: v })} /></Field>
        <Field label="Type">
          <Select value={r.uncertainty?.type ?? 'sd'} onChange={(e) => set('uncertainty', { ...r.uncertainty, type: e.target.value })}>
            <option value="sd">± SD</option><option value="se">± SE</option><option value="ci95">± 95 % CI</option><option value="range">range</option><option value="text">text</option>
          </Select>
        </Field>
        <Field label="Replicates n"><NumInput value={r.n ?? null} onChange={(v) => set('n', v)} /></Field>
      </div>
      <div>
        <div className="mb-0.5 flex items-center justify-between text-[11px] font-medium text-neutral-500"><span>Experimental conditions</span>
          {unusedConds.length > 0 && (
            <select className="h-6 rounded border border-neutral-300 bg-white text-[11px] dark:border-neutral-700 dark:bg-neutral-950" value="" onChange={(e) => e.target.value && set('conditions', { ...r.conditions, [e.target.value]: null })}>
              <option value="">+ add condition</option>
              {unusedConds.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          )}
        </div>
        {Object.keys(r.conditions ?? {}).length === 0 && <div className="text-[11px] text-amber-700 dark:text-amber-400">No conditions stated — comparability is limited.</div>}
        {Object.entries(r.conditions ?? {}).map(([k, v]) => (
          <div key={k} className="mb-1 grid grid-cols-[1fr_90px_20px] items-center gap-1">
            <span className="truncate">{condLabels[k]?.label ?? k} {condLabels[k]?.unit ? `[${unitLabel(condLabels[k].unit)}]` : ''}</span>
            <NumInput value={typeof v === 'number' ? v : v === null ? null : Number(v)} onChange={(nv) => set('conditions', { ...r.conditions, [k]: nv })} />
            <button onClick={() => { const c = { ...r.conditions }; delete c[k]; set('conditions', c) }} className="text-neutral-400 hover:text-rose-600"><X className="h-3 w-3" /></button>
          </div>
        ))}
      </div>
      {!compact && <Field label="Formulation / sample composition"><Input className="w-full" value={r.composition ?? ''} onChange={(e) => set('composition', e.target.value)} placeholder="e.g. 15 % w/w PPI in water" /></Field>}
      <Field label="Measurement method"><Input className="w-full" value={r.method ?? ''} onChange={(e) => set('method', e.target.value)} placeholder="e.g. rotational rheometer, cone-plate" /></Field>
      <div className="rounded border border-neutral-200 p-1.5 dark:border-neutral-700">
        <div className="mb-1 text-[11px] font-medium text-neutral-500">Source</div>
        {papers && papers.length > 0 && (
          <Field label="Paper"><Select value={r.source?.paper_id ?? ''} onChange={(e) => set('source', { ...r.source, paper_id: e.target.value || undefined })}><option value="">— none —</option>{papers.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</Select></Field>
        )}
        <div className="mt-1 grid grid-cols-[1fr_70px] gap-1.5">
          <Field label="Citation"><Input className="w-full" value={r.source?.citation ?? ''} onChange={(e) => set('source', { ...r.source, citation: e.target.value })} /></Field>
          <Field label="Page"><NumInput value={r.source?.page ?? null} onChange={(v) => set('source', { ...r.source, page: v ?? undefined })} /></Field>
        </div>
        <Field label="Supporting passage / table reference" className="mt-1"><textarea className={cx(inputCls, 'h-14 w-full py-1')} value={r.source?.snippet ?? ''} onChange={(e) => set('source', { ...r.source, snippet: e.target.value })} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Field label="Evidence type"><Select value={r.evidence_type} onChange={(e) => set('evidence_type', e.target.value)}>{Object.entries(catalog.evidence_types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Review status">
          <Select value={r.review_status} onChange={(e) => set('review_status', e.target.value)}>{catalog.review_statuses.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
        </Field>
      </div>
      <Field label="Notes"><Input className="w-full" value={r.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
      <div className="flex flex-wrap items-center gap-1 pt-1">
        <span className={cx('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', STATUS_STYLE[r.review_status])}>{r.review_status}</span>
        <div className="flex-1" />
        {onDelete && <Button size="sm" variant="ghost" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>}
        {onCancel && <Button size="sm" onClick={onCancel}>Cancel</Button>}
        {r.review_status !== 'approved' && <Button size="sm" onClick={() => onSave({ ...r, review_status: 'approved' })}><Check className="h-3.5 w-3.5" />Approve</Button>}
        <Button size="sm" variant="primary" onClick={() => onSave(r)}>{r.id ? <Save className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}{r.id ? 'Save' : 'Add'}</Button>
      </div>
    </div>
  )
}
