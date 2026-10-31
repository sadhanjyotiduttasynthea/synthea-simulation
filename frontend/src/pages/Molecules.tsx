import { Atom as AtomIcon, Download, FileUp, FlaskConical, Link2, Play, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import { Equation } from '../components/Equation'
import { GraphicsView } from '../components/GraphicsView'
import { HBondLines, MoleculeModel, centroid, elementColor, type Atom, type ColorBy, type MolStyle, type TracePt } from '../components/MoleculeScene'
import { Plot } from '../components/Plot'
import { Alert, Badge, Button, Field, Input, KV, Modal, NumInput, PageHeader, Panel, Select, Spinner, Tabs, cx } from '../components/ui'
import { api, pickFile } from '../lib/api'
import { useStore } from '../store'
import { useCommand } from '../workspace/commands'
import { refreshTree } from '../workspace/ModelTree'
import { Inspector, PlotsSlot, ResultsSlot, useEquations } from '../workspace/Slots'
import { log } from '../workspace/wsStore'

type Dict = Record<string, unknown>
interface Mol {
  id: string; name: string; kind: 'small' | 'protein'; source: Dict; structure_label: string; material_ids: string[]
  atoms: Atom[]; bonds: number[][]; trace?: TracePt[]; sequence?: string; properties: Dict; has_secondary_structure?: boolean
}
interface MolRow { id: string; name: string; kind: string; formula?: string; molar_mass_g_mol?: number; atoms: number; residues?: number; structure_label: string; material_ids: string[] }
interface Starter { name: string; smiles: string; category: string }
interface Cand { property: string; value: number; unit: string; conditions: Dict; method?: string }
interface Inter {
  computed: boolean; label: string; method?: string; interaction_energy_kcal_mol?: number; interaction_energy_kj_mol?: number; rigid_best_kcal_mol?: number
  scan?: { distance_a: number; e_min_kcal_mol: number | null }[]; hydrogen_bonds?: { donor: number; hydrogen: number; acceptor: number; distance_a: number; angle_deg: number }[]
  a: { id: string; xyz: number[][] }; b: { id: string; xyz: number[][] }; orientations?: number; equation?: string; optimised?: boolean
}
type Mode = 'structure' | 'interaction'

const fmt = (v: unknown, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) !== 0 && (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3) ? v.toExponential(d - 1) : String(+v.toPrecision(d))) : '—')
const PROP_LABEL: Record<string, string> = { molar_mass: 'Molar mass', hydrodynamic_radius: 'Hydrodynamic radius', diffusion_coefficient: 'Diffusion coefficient in water', isoelectric_point: 'Isoelectric point', net_charge: 'Net charge', amino_acid_score: 'Amino acid score' }

export default function Molecules() {
  const [params, setParams] = useSearchParams()
  const projectId = useStore((s) => s.projectId)
  const toast = useStore((s) => s.toast)
  const [list, setList] = useState<MolRow[]>([])
  const [mol, setMol] = useState<Mol | null>(null)
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode) || 'structure')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [style, setStyle] = useState<MolStyle>('ballstick')
  const [colorBy, setColorBy] = useState<ColorBy>('ss')
  const [materials, setMaterials] = useState<{ id: string; name: string }[]>([])
  const mid = params.get('mol')

  const load = useCallback(() => api.get<MolRow[]>('/api/molecules').then((l) => {
    setList(l)
    if (!mid && l[0]) setParams({ mol: l[0].id }, { replace: true })
    return l
  }), [mid, setParams])
  useEffect(() => { load(); api.get<{ id: string; name: string }[]>('/api/materials').then((m) => setMaterials(m.map((x) => ({ id: x.id, name: x.name })))) }, [load])
  useEffect(() => {
    if (!mid) { setMol(null); return }
    api.get<Mol>(`/api/molecules/${mid}`).then((m) => {
      setMol(m)
      setStyle(m.kind === 'protein' ? (m.atoms.length > 1500 ? 'cartoon' : 'cartoon+atoms') : 'ballstick')
      setColorBy(m.source?.type === 'alphafold' ? 'plddt' : m.has_secondary_structure ? 'ss' : 'hydropathy')
    }).catch(() => setMol(null))
  }, [mid])

  const created = async (m: Mol) => {
    setAdding(false)
    await load()
    refreshTree()
    setParams({ mol: m.id })
    log('success', 'molecules', `Added ${m.name} (${m.structure_label})`)
  }
  const add = async (body: Dict) => {
    setBusy('Building structure…')
    try { await created(await api.post<Mol>('/api/molecules', { ...body, project_id: projectId })) } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  const upload = async () => {
    const f = await pickFile('.pdb,.ent,.mol,.sdf,.sd,.fasta,.fa,.txt')
    setBusy(`Reading ${f.name}…`)
    try { await created(await api.upload<Mol>('/api/molecules/upload', f, f.name, { project_id: projectId ?? '' })) } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  const fetchStructure = async (source: string, id: string) => {
    setBusy(`Downloading ${id}…`)
    try { await created(await api.post<Mol>('/api/molecules/fetch', { source, id, project_id: projectId })) } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  const remove = async () => {
    if (!mol || !confirm(`Delete ${mol.name}?`)) return
    await api.del(`/api/molecules/${mol.id}`)
    const l = await load()
    refreshTree()
    setParams(l.find((x) => x.id !== mol.id) ? { mol: l.find((x) => x.id !== mol.id)!.id } : {})
  }
  useCommand('molecule.new', () => setAdding(true))

  const eqs = mol ? Object.entries((mol.properties.equations as Record<string, string>) ?? {}).map(([k, latex]) => ({ title: k === 'charge' ? 'Net charge (Henderson–Hasselbalch)' : 'Stokes–Einstein diffusion', latex })) : []
  useEquations(eqs, [mol?.id])

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Molecular structures" subtitle="Any small molecule (SMILES, MOL/SDF), peptides and proteins (sequence, PDB, AlphaFold). Computed properties can be added to library materials and used by the digital twins."
        actions={<>
          <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Add molecule</Button>
          <Button size="sm" onClick={upload}><FileUp className="h-3.5 w-3.5" />Upload file</Button>
        </>} />
      <Tabs<Mode> value={mode} onChange={setMode} tabs={[{ id: 'structure', label: 'Structure & properties' }, { id: 'interaction', label: 'Interaction scene' }]} />
      {busy && <Spinner label={busy} />}
      <div className="grid min-h-0 flex-1 gap-3 pt-2 @4xl:grid-cols-[220px_minmax(0,1fr)]">
        <Panel title={`Molecules (${list.length})`} bodyClass="p-1" className="min-h-0 overflow-y-auto">
          {list.length === 0 && <p className="p-2 text-xs text-neutral-500">No molecules yet. Use Add molecule (SMILES, starter set, sequence, PDB / AlphaFold) or upload a file.</p>}
          {list.map((m) => (
            <button key={m.id} onClick={() => setParams({ mol: m.id })} className={cx('mb-0.5 w-full rounded px-2 py-1.5 text-left text-xs', m.id === mid ? 'bg-neutral-900 text-white dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>
              <div className="flex items-center gap-1.5"><AtomIcon className="h-3.5 w-3.5 shrink-0 text-rose-500" /><span className="truncate font-medium">{m.name}</span></div>
              <div className="pl-5 text-[10px] opacity-75">{m.kind === 'protein' ? `${m.residues} residues` : m.formula} · {fmt(m.molar_mass_g_mol, 5)} g/mol{m.material_ids.length ? ` · linked ${m.material_ids.length}` : ''}</div>
            </button>
          ))}
        </Panel>
        <div className="min-h-0">
          {mode === 'structure' ? (mol ? <StructureView mol={mol} style={style} setStyle={setStyle} colorBy={colorBy} setColorBy={setColorBy} /> : <Alert>Select or add a molecule.</Alert>)
            : <InteractionView list={list} first={mol} />}
        </div>
      </div>
      {mol && mode === 'structure' && (
        <Inspector>
          <MoleculeInspector mol={mol} materials={materials} onChange={(m) => { setMol(m); load() }} onDelete={remove} />
        </Inspector>
      )}
      <AddDialog open={adding} onClose={() => setAdding(false)} onAdd={add} onFetch={fetchStructure} onUpload={() => { setAdding(false); upload() }} />
    </div>
  )
}

/* ------------------------------------------------------------------ structure */
function StructureView({ mol, style, setStyle, colorBy, setColorBy }: { mol: Mol; style: MolStyle; setStyle: (s: MolStyle) => void; colorBy: ColorBy; setColorBy: (c: ColorBy) => void }) {
  const c = useMemo(() => centroid(mol.atoms), [mol])
  const atoms = useMemo(() => mol.atoms.map((a) => ({ ...a, x: a.x - c[0], y: a.y - c[1], z: a.z - c[2] })), [mol, c])
  const trace = useMemo(() => mol.trace?.map((t) => ({ ...t, x: t.x - c[0], y: t.y - c[1], z: t.z - c[2] })), [mol, c])
  const [fit, setFit] = useState(0)
  const onReady = useCallback(() => { setTimeout(() => setFit((f) => f + 1), 30) }, [])
  const ext = useMemo(() => Math.max(10, ...atoms.map((a) => Math.hypot(a.x, a.y, a.z))), [atoms])
  const p = mol.properties
  const elements = useMemo(() => Array.from(new Set(mol.atoms.map((a) => a.el))).sort(), [mol])
  const isProt = mol.kind === 'protein'
  const label = mol.structure_label
  const warn = /UNFOLDED|PREDICTED|sequence only/i.test(label)
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select value={style} onChange={(e) => setStyle(e.target.value as MolStyle)} className="w-40">
          <option value="ballstick">Ball & stick</option><option value="stick">Sticks</option><option value="spacefill">Space-filling (vdW)</option>
          {isProt && !!mol.trace?.length && <><option value="cartoon">Backbone tube</option><option value="cartoon+atoms">Tube + atoms</option></>}
        </Select>
        {isProt && style.startsWith('cartoon') && (
          <Select value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)} className="w-44">
            <option value="ss">Secondary structure</option><option value="chain">Chain</option><option value="hydropathy">Hydropathy (Kyte–Doolittle)</option><option value="plddt">pLDDT / B-factor</option>
          </Select>
        )}
        <Badge tone={warn ? 'amber' : 'green'}>{label}</Badge>
      </div>
      <div className="min-h-0 flex-1">
        {mol.atoms.length ? (
          <GraphicsView unit="Å" gridSize={Math.ceil(ext * 3 / 10) * 10} fitSignal={fit}
            legend={<div className="flex flex-wrap gap-1 rounded bg-black/60 p-1.5 text-[10px] text-white">{elements.map((e) => <span key={e} className="flex items-center gap-0.5"><span className="h-2 w-2 rounded-full" style={{ background: elementColor(e) }} />{e}</span>)}</div>}>
            <MoleculeModel atoms={atoms} bonds={mol.bonds} trace={trace} style={style} colorBy={colorBy} onReady={onReady} />
          </GraphicsView>
        ) : <SequenceStrip seq={mol.sequence ?? ''} />}
      </div>
      <ResultsSlot>
        <div className="grid gap-3 text-xs @3xl:grid-cols-2">
          <KV rows={isProt ? [
            ['Residues', String(p.residues)], ['Molar mass', `${fmt(p.molar_mass_g_mol, 6)} g/mol`], ['Isoelectric point (computed)', fmt(p.isoelectric_point, 3)],
            [`Net charge at pH ${p.ph}`, fmt(p.net_charge_at_ph, 3)], ['ε280 (oxidised / reduced)', `${p.extinction_280_oxidised} / ${p.extinction_280_reduced} M⁻¹cm⁻¹`],
            ['GRAVY (Kyte–Doolittle)', fmt(p.gravy, 3)], ['Aliphatic index', fmt(p.aliphatic_index, 3)],
            ...(p.radius_of_gyration_nm ? [['Radius of gyration (structure)', `${fmt(p.radius_of_gyration_nm, 3)} nm`] as [string, string]] : []),
            ['Hydrodynamic radius (estimate)', `${fmt(p.hydrodynamic_radius_nm, 3)} nm`], [`Diffusion coefficient in water, ${p.temperature_c} °C`, `${fmt(p.diffusion_coefficient_m2_s, 3)} m²/s`],
          ] : [
            ['Formula', String(p.formula)], ['Molar mass', `${fmt(p.molar_mass_g_mol, 6)} g/mol`], ['logP (Crippen)', fmt(p.logp_crippen, 3)], ['TPSA', `${fmt(p.tpsa_a2, 4)} Å²`],
            ['H-bond donors / acceptors', `${p.h_bond_donors} / ${p.h_bond_acceptors}`], ['Rotatable bonds', String(p.rotatable_bonds)], ['vdW volume', `${fmt(p.vdw_volume_a3, 4)} Å³`],
            ['Radius of gyration', `${fmt(p.radius_of_gyration_a, 3)} Å`], ...(p.force_field ? [[`Conformer energy (${p.force_field})`, `${fmt(p.conformer_energy_kcal_mol, 4)} kcal/mol`] as [string, string]] : []),
            ['Hydrodynamic radius (estimate)', `${fmt(p.hydrodynamic_radius_nm, 3)} nm`], [`Diffusion coefficient in water, ${p.temperature_c} °C`, `${fmt(p.diffusion_coefficient_m2_s, 3)} m²/s`],
          ]} />
          <div className="space-y-1">
            <div className="text-[11px] text-neutral-500">{String(p.hydrodynamic_radius_method)}{p.diffusion_note ? ` — ${p.diffusion_note}` : ''}</div>
            {isProt && <AAScore p={p} />}
            {!!mol.source?.license && <div className="text-[11px] text-neutral-500">Source: {String(mol.source.url)} — {String(mol.source.license)}</div>}
          </div>
        </div>
      </ResultsSlot>
      {isProt && (
        <PlotsSlot>
          <Plot height={240} data={[{ x: (p.charge_curve as { ph: number }[]).map((c) => c.ph), y: (p.charge_curve as { charge: number }[]).map((c) => c.charge), type: 'scatter', mode: 'lines', name: 'net charge' }]}
            layout={{ title: { text: `Net charge vs pH (pI = ${fmt(p.isoelectric_point, 3)})`, font: { size: 11 } }, xaxis: { title: { text: 'pH' } }, yaxis: { title: { text: 'Z' } },
              shapes: [{ type: 'line', x0: 1, x1: 13, y0: 0, y1: 0, line: { dash: 'dot', width: 1 } }] }} />
        </PlotsSlot>
      )}
    </div>
  )
}

function AAScore({ p }: { p: Dict }) {
  const s = p.amino_acid_score as { per_amino_acid: Record<string, { mg_per_g: number; reference_mg_per_g: number; ratio: number }>; limiting: string; score: number; note: string; pattern: string }
  return (
    <div>
      <div className="mb-0.5 font-semibold">Amino-acid score {fmt(s.score, 3)} (limiting: {s.limiting})</div>
      <table className="w-full text-[11px]"><tbody>
        {Object.entries(s.per_amino_acid).map(([k, v]) => (
          <tr key={k} className={cx('border-t border-neutral-200 dark:border-white/10', k === s.limiting && 'font-semibold text-rose-600')}><td>{k}</td><td className="num text-right">{fmt(v.mg_per_g, 3)}</td><td className="num text-right text-neutral-500">{v.reference_mg_per_g}</td><td className="num text-right">{fmt(v.ratio, 3)}</td></tr>
        ))}
      </tbody></table>
      <div className="text-[10px] text-neutral-500">mg/g protein vs {s.pattern} (mg/g). {s.note}</div>
    </div>
  )
}

function SequenceStrip({ seq }: { seq: string }) {
  const KD: Record<string, number> = { A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5, G: -0.4, H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6, S: -0.8, T: -0.7, W: -0.9, Y: -1.3, V: 4.2 }
  return (
    <div className="h-full overflow-auto rounded border border-neutral-200 p-3 dark:border-white/10">
      <p className="mb-2 text-xs text-neutral-500">No 3-D structure: a sequence alone does not determine coordinates here. Load a PDB or AlphaFold file to view the fold. Colour = hydropathy (orange hydrophobic, teal hydrophilic).</p>
      <div className="flex flex-wrap gap-0.5 font-mono text-[11px]">
        {seq.split('').map((r, i) => {
          const v = (KD[r] ?? 0) / 4.5
          return <span key={i} title={`${r}${i + 1}`} className="w-4 rounded text-center" style={{ background: new THREE.Color(v > 0 ? '#f59e0b' : '#0891b2').lerp(new THREE.Color('#ffffff'), 1 - Math.abs(v)).getStyle() }}>{r}</span>
        })}
      </div>
    </div>
  )
}

function MoleculeInspector({ mol, materials, onChange, onDelete }: { mol: Mol; materials: { id: string; name: string }[]; onChange: (m: Mol) => void; onDelete: () => void }) {
  const toast = useStore((s) => s.toast)
  const [T, setT] = useState<number>((mol.properties.temperature_c as number) ?? 25)
  const [pH, setPH] = useState<number>((mol.properties.ph as number) ?? 7)
  const [cands, setCands] = useState<Cand[]>([])
  const [sel, setSel] = useState<string[]>([])
  const [target, setTarget] = useState<string>(mol.material_ids[0] ?? materials[0]?.id ?? '')
  const [status, setStatus] = useState('reviewed')
  useEffect(() => {
    api.get<Cand[]>(`/api/molecules/${mol.id}/library-candidates`).then((c) => { setCands(c); setSel(c.filter((x) => x.property === 'diffusion_coefficient').map((x) => x.property)) })
    setT((mol.properties.temperature_c as number) ?? 25)
  }, [mol])
  const recompute = async () => onChange(await api.post<Mol>(`/api/molecules/${mol.id}/properties`, { temperature_c: T, ph: pH }))
  const link = async (ids: string[]) => onChange(await api.put<Mol>(`/api/molecules/${mol.id}`, { material_ids: ids }))
  const send = async () => {
    const r = await api.post<{ created: string[] }>(`/api/molecules/${mol.id}/to-library`, { material_id: target, properties: sel, review_status: status })
    toast(`${r.created.length} computed record(s) added to ${materials.find((m) => m.id === target)?.name} as '${status}'`, 'success')
    onChange(await api.get<Mol>(`/api/molecules/${mol.id}`))
    refreshTree()
  }
  return (
    <div className="space-y-3 text-xs">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Molecule</div>
      <Field label="Name"><Input defaultValue={mol.name} key={mol.id} onBlur={(e) => e.target.value !== mol.name && api.put<Mol>(`/api/molecules/${mol.id}`, { name: e.target.value }).then(onChange)} /></Field>
      {mol.sequence && <Field label={`Sequence (${mol.sequence.length})`}><div className="max-h-20 overflow-auto break-all rounded bg-neutral-100 p-1 font-mono text-[10px] dark:bg-white/5">{mol.sequence}</div></Field>}
      <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Conditions</div>
      <div className="grid grid-cols-2 gap-1">
        <Field label="Temperature [°C]"><NumInput value={T} onChange={(v) => v != null && setT(v)} allowNull={false} /></Field>
        {mol.kind === 'protein' && <Field label="pH"><NumInput value={pH} onChange={(v) => v != null && setPH(v)} allowNull={false} /></Field>}
      </div>
      <Button size="sm" onClick={recompute}><Play className="h-3 w-3" />Recompute properties</Button>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500"><Link2 className="mr-1 inline h-3 w-3" />Linked library materials</div>
      <div className="max-h-28 space-y-0.5 overflow-auto">
        {materials.map((m) => (
          <label key={m.id} className="flex items-center gap-1"><input type="checkbox" checked={mol.material_ids.includes(m.id)} onChange={(e) => link(e.target.checked ? [...mol.material_ids, m.id] : mol.material_ids.filter((x) => x !== m.id))} />{m.name}</label>
        ))}
      </div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Feed into simulations</div>
      <p className="text-[11px] text-neutral-500">Computed values become library property records (evidence: computed from structure). Twins use them once they are approved for calculation.</p>
      <div className="space-y-0.5">
        {cands.map((c) => (
          <label key={c.property} className="flex items-start gap-1">
            <input type="checkbox" className="mt-0.5" checked={sel.includes(c.property)} onChange={(e) => setSel(e.target.checked ? [...sel, c.property] : sel.filter((x) => x !== c.property))} />
            <span>{PROP_LABEL[c.property] ?? c.property}: <b className="num">{fmt(c.value)}</b> {c.unit.replace('**2', '²')}{Object.keys(c.conditions).length ? ` (${Object.entries(c.conditions).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}</span>
          </label>
        ))}
      </div>
      <Field label="Material"><Select value={target} onChange={(e) => setTarget(e.target.value)}>{materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
      <Field label="Review status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="reviewed">Reviewed (not yet used in calculations)</option><option value="approved">Approved for calculation</option></Select></Field>
      <Button size="sm" variant="primary" onClick={send} disabled={!sel.length || !target}>Add {sel.length} record(s) to library</Button>
      <div className="pt-2"><Button size="sm" variant="ghost" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />Delete molecule</Button></div>
    </div>
  )
}

/* ------------------------------------------------------------------ interaction scenes */
function InteractionView({ list, first }: { list: MolRow[]; first: Mol | null }) {
  const [a, setA] = useState(first?.id ?? list[0]?.id ?? '')
  const [b, setB] = useState(list.find((m) => m.id !== (first?.id ?? list[0]?.id))?.id ?? '')
  const [orient, setOrient] = useState(24)
  const [opt, setOpt] = useState(true)
  const [res, setRes] = useState<Inter | null>(null)
  const [mols, setMols] = useState<{ a: Mol; b: Mol } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [fit, setFit] = useState(0)
  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const [ma, mb, r] = await Promise.all([api.get<Mol>(`/api/molecules/${a}`), api.get<Mol>(`/api/molecules/${b}`), api.post<Inter>('/api/molecules/interaction', { a, b, orientations: orient, optimise: opt })])
      setMols({ a: ma, b: mb })
      setRes(r)
      log(r.computed ? 'success' : 'warn', 'molecules', r.computed ? `E_int(${ma.name}, ${mb.name}) = ${fmt(r.interaction_energy_kcal_mol)} kcal/mol (MMFF94, vacuum)` : r.label)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const scene = useMemo(() => {
    if (!res || !mols) return null
    const all = [...res.a.xyz, ...res.b.xyz]
    const c = centroid(all.map(([x, y, z]) => ({ x, y, z })))
    const mk = (m: Mol, xyz: number[][]) => m.atoms.map((at, i) => ({ ...at, x: xyz[i][0] - c[0], y: xyz[i][1] - c[1], z: xyz[i][2] - c[2] }))
    const atA = mk(mols.a, res.a.xyz)
    const atB = mk(mols.b, res.b.xyz)
    const both = [...atA, ...atB]
    const hb = (res.hydrogen_bonds ?? []).map((h) => [new THREE.Vector3(both[h.hydrogen].x, both[h.hydrogen].y, both[h.hydrogen].z), new THREE.Vector3(both[h.acceptor].x, both[h.acceptor].y, both[h.acceptor].z)] as [THREE.Vector3, THREE.Vector3])
    return { atA, atB, hb }
  }, [res, mols])
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <Field label="Molecule A"><Select value={a} onChange={(e) => setA(e.target.value)} className="w-52">{list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Molecule B"><Select value={b} onChange={(e) => setB(e.target.value)} className="w-52">{list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Orientations"><NumInput value={orient} onChange={(v) => v && setOrient(Math.max(1, Math.min(200, Math.round(v))))} className="w-20" allowNull={false} /></Field>
        <label className="flex items-center gap-1 pb-1.5"><input type="checkbox" checked={opt} onChange={(e) => setOpt(e.target.checked)} />Minimise complex</label>
        <Button variant="primary" onClick={run} loading={busy} disabled={!a || !b}><Play className="h-3.5 w-3.5" />Compute scene</Button>
      </div>
      {err && <Alert kind="error">{err}</Alert>}
      {res && <Alert kind={res.computed ? 'info' : 'warn'}>{res.label}</Alert>}
      <div className="min-h-0 flex-1">
        {scene ? (
          <GraphicsView unit="Å" gridSize={40} fitSignal={fit}>
            <MoleculeModel atoms={scene.atA} bonds={mols!.a.bonds} trace={undefined} style="ballstick" />
            <MoleculeModel atoms={scene.atB} bonds={mols!.b.bonds} style="ballstick" onReady={() => setTimeout(() => setFit((f) => f + 1), 30)} />
            <HBondLines pairs={scene.hb} />
          </GraphicsView>
        ) : <div className="p-6 text-sm text-neutral-500">Choose two molecules and compute. Small-molecule pairs get a force-field interaction energy; scenes with proteins are conceptual placements.</div>}
      </div>
      {res?.computed && (
        <>
          <ResultsSlot>
            <div className="grid gap-3 text-xs @3xl:grid-cols-2">
              <div>
                <div className="mb-1"><Equation latex={res.equation ?? ''} /></div>
                <KV rows={[['Interaction energy', `${fmt(res.interaction_energy_kcal_mol)} kcal/mol (${fmt(res.interaction_energy_kj_mol)} kJ/mol)`], ['Best rigid pose', `${fmt(res.rigid_best_kcal_mol)} kcal/mol`],
                  ['Orientations searched', String(res.orientations)], ['Complex minimised', res.optimised ? 'yes' : 'no'], ['Hydrogen bonds (D–H···A ≤ 3.5 Å, ≥ 120°)', String(res.hydrogen_bonds?.length ?? 0)]]} />
              </div>
              <div className="text-[11px] text-neutral-500">{res.method}</div>
            </div>
          </ResultsSlot>
          <PlotsSlot>
            <Plot height={240} data={[{ x: res.scan!.map((s) => s.distance_a), y: res.scan!.map((s) => s.e_min_kcal_mol), type: 'scatter', mode: 'lines+markers', marker: { size: 3 }, name: 'best orientation' }]}
              layout={{ title: { text: 'Rigid scan: lowest interaction energy vs centre distance', font: { size: 11 } }, xaxis: { title: { text: 'centre–centre distance [Å]' } }, yaxis: { title: { text: 'E_int [kcal/mol]' } } }} />
          </PlotsSlot>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ add dialog */
function AddDialog({ open, onClose, onAdd, onFetch, onUpload }: { open: boolean; onClose: () => void; onAdd: (b: Dict) => void; onFetch: (s: string, id: string) => void; onUpload: () => void }) {
  type T = 'smiles' | 'starter' | 'sequence' | 'download'
  const [t, setT] = useState<T>('starter')
  const [name, setName] = useState('')
  const [smiles, setSmiles] = useState('')
  const [seq, setSeq] = useState('')
  const [conf, setConf] = useState(true)
  const [src, setSrc] = useState('pdb')
  const [ident, setIdent] = useState('')
  const [starters, setStarters] = useState<Starter[]>([])
  useEffect(() => { if (open) api.get<Starter[]>('/api/molecules/starters').then(setStarters) }, [open])
  return (
    <Modal open={open} onClose={onClose} title="Add molecule" wide>
      <Tabs<T> value={t} onChange={setT} tabs={[{ id: 'starter', label: 'Food-molecule starter set' }, { id: 'smiles', label: 'SMILES (any small molecule)' }, { id: 'sequence', label: 'Protein / peptide sequence' }, { id: 'download', label: 'PDB / AlphaFold' }]} />
      <div className="space-y-2 pt-3 text-sm">
        {t === 'starter' && (
          <div className="grid gap-1 sm:grid-cols-2">
            {starters.map((s) => (
              <button key={s.name} onClick={() => onAdd({ smiles: s.smiles, name: s.name })} className="flex items-center justify-between rounded border border-neutral-200 px-2 py-1.5 text-left text-xs hover:border-rose-400 dark:border-white/10">
                <span><b>{s.name}</b><br /><span className="text-neutral-500">{s.category}</span></span><FlaskConical className="h-4 w-4 text-rose-500" />
              </button>
            ))}
          </div>
        )}
        {t === 'smiles' && (
          <>
            <Field label="SMILES"><Input value={smiles} onChange={(e) => setSmiles(e.target.value)} placeholder="e.g. CC(=O)O" className="w-full font-mono" /></Field>
            <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" /></Field>
            <p className="text-xs text-neutral-500">A 3-D conformer is generated with RDKit (ETKDG v3) and minimised with MMFF94. Up to 300 heavy atoms; larger molecules need a structure file.</p>
            <Button variant="primary" onClick={() => onAdd({ smiles, name })} disabled={!smiles.trim()}>Build</Button>
          </>
        )}
        {t === 'sequence' && (
          <>
            <Field label="Sequence (one-letter codes or FASTA)"><textarea value={seq} onChange={(e) => setSeq(e.target.value)} className="h-28 w-full rounded border border-neutral-300 bg-white p-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950" placeholder=">my protein&#10;MSKLL…" /></Field>
            <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" /></Field>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={conf} onChange={(e) => setConf(e.target.checked)} />Build a computed conformer of the unfolded chain for peptides ≤ 40 residues</label>
            <p className="text-xs text-neutral-500">Properties (molar mass, pI, charge vs pH, ε280, GRAVY, amino-acid score, diffusion estimate) are computed from the sequence. A folded structure needs a PDB / AlphaFold file.</p>
            <Button variant="primary" onClick={() => onAdd({ sequence: seq, name, build_conformer: conf })} disabled={!seq.trim()}>Compute</Button>
          </>
        )}
        {t === 'download' && (
          <>
            <div className="flex gap-2">
              <Field label="Database"><Select value={src} onChange={(e) => setSrc(e.target.value)}><option value="pdb">RCSB PDB (experimental, CC0)</option><option value="alphafold">AlphaFold DB (predicted, CC-BY 4.0)</option></Select></Field>
              <Field label={src === 'pdb' ? 'PDB ID' : 'UniProt accession'}><Input value={ident} onChange={(e) => setIdent(e.target.value)} placeholder={src === 'pdb' ? '1CRN' : 'P13915'} /></Field>
            </div>
            <p className="text-xs text-neutral-500">Needs internet access from the compute engine. Offline: download the .pdb file in a browser and use Upload file.</p>
            <div className="flex gap-2"><Button variant="primary" onClick={() => onFetch(src, ident)} disabled={!ident.trim()}><Download className="h-3.5 w-3.5" />Download</Button><Button onClick={onUpload}><FileUp className="h-3.5 w-3.5" />Upload file instead</Button></div>
          </>
        )}
      </div>
    </Modal>
  )
}
