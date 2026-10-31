import { Html, Line, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { Atom, FileUp, Pause, RotateCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Alert, Badge, Button, Field, KV, NumInput, PageHeader, Panel, Select, Spinner, cx } from '../components/ui'
import { api, pickFile } from '../lib/api'
import { fmtSci } from '../lib/format'
import type { Material } from '../lib/sci'
import { useStore } from '../store'
import { Inspector, useEquations } from '../workspace/Slots'
import { log } from '../workspace/wsStore'

interface AtomT { el: string; x: number; y: number; z: number; charge?: number; res?: string | null; donor?: boolean; acceptor?: boolean }
interface MolT { name: string; atoms: AtomT[]; bonds: { a: number; b: number; order: number }[]; hbonds?: { a: number; b: number }[]; properties?: Record<string, number | string>; provenance: string; property_note?: string; title?: string; kind?: string; facts?: string[]; smiles?: string }
interface AggT { particles: { x: number; y: number; z: number; state: string }[]; title: string; kind: string; denatured_fraction: number | null; provenance: string; facts: string[]; model_id: string | null }

// CPK/Jmol colours and Bondi (1964) van der Waals radii [Å]
const COLOR: Record<string, string> = { H: '#ffffff', C: '#909090', N: '#3050f8', O: '#ff0d0d', S: '#ffff30', P: '#ff8000', Na: '#ab5cf2', Cl: '#1ff01f', K: '#8f40d4', Ca: '#3dff00', Fe: '#e06633', Mg: '#8aff00' }
const VDW: Record<string, number> = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, S: 1.8, P: 1.8, Na: 2.27, Cl: 1.75, K: 2.75, Ca: 2.31, Fe: 2.0, Mg: 1.73 }
type Style = 'ballstick' | 'spacefill' | 'sticks'
type Mode = { kind: 'molecule'; key: string } | { kind: 'file' } | { kind: 'scene'; name: 'water' | 'hydration' | 'starch' | 'aggregation' | 'emulsion' }

function Atoms({ atoms, style }: { atoms: AtomT[]; style: Style }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const mat = new THREE.Matrix4(), col = new THREE.Color()
    atoms.forEach((a, i) => {
      const r = style === 'spacefill' ? VDW[a.el] ?? 1.7 : style === 'sticks' ? 0.18 : (VDW[a.el] ?? 1.7) * (a.el === 'H' ? 0.22 : 0.28)
      mat.compose(new THREE.Vector3(a.x, a.y, a.z), new THREE.Quaternion(), new THREE.Vector3(r, r, r))
      m.setMatrixAt(i, mat)
      m.setColorAt(i, col.set(COLOR[a.el] ?? '#ff69b4'))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [atoms, style])
  return (
    <instancedMesh key={atoms.length + style} ref={ref} args={[undefined, undefined, atoms.length]}>
      <sphereGeometry args={[1, atoms.length > 3000 ? 8 : 24, atoms.length > 3000 ? 6 : 16]} />
      <meshStandardMaterial roughness={0.35} metalness={0.05} />
    </instancedMesh>
  )
}

function Bonds({ atoms, bonds, style }: { atoms: AtomT[]; bonds: MolT['bonds']; style: Style }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const segs = useMemo(() => bonds.flatMap((b) => {
    const a = atoms[b.a], c = atoms[b.b]
    if (!a || !c) return []
    const p = new THREE.Vector3(a.x, a.y, a.z), q = new THREE.Vector3(c.x, c.y, c.z)
    const mid = p.clone().lerp(q, 0.5)
    if (b.order >= 2 && style !== 'sticks') {
      const dir = q.clone().sub(p).normalize()
      const off = new THREE.Vector3(0, 0, 1).cross(dir)
      if (off.lengthSq() < 1e-6) off.set(1, 0, 0)
      off.normalize().multiplyScalar(0.09)
      return [[p.clone().add(off), mid.clone().add(off), a.el], [mid.clone().add(off), q.clone().add(off), c.el], [p.clone().sub(off), mid.clone().sub(off), a.el], [mid.clone().sub(off), q.clone().sub(off), c.el]] as [THREE.Vector3, THREE.Vector3, string][]
    }
    return [[p, mid, a.el], [mid, q, c.el]] as [THREE.Vector3, THREE.Vector3, string][]
  }), [atoms, bonds, style])
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const mat = new THREE.Matrix4(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color()
    segs.forEach(([p, q, el], i) => {
      const d = q.clone().sub(p), len = d.length()
      const quat = new THREE.Quaternion().setFromUnitVectors(up, d.clone().normalize())
      const r = style === 'sticks' ? 0.16 : 0.1
      mat.compose(p.clone().add(q).multiplyScalar(0.5), quat, new THREE.Vector3(r, len, r))
      m.setMatrixAt(i, mat)
      m.setColorAt(i, col.set(COLOR[el] ?? '#cccccc'))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [segs, style])
  if (style === 'spacefill' || !segs.length) return null
  return (
    <instancedMesh key={segs.length + style} ref={ref} args={[undefined, undefined, segs.length]}>
      <cylinderGeometry args={[1, 1, 1, 10]} />
      <meshStandardMaterial roughness={0.4} />
    </instancedMesh>
  )
}

function Spin({ on, children }: { on: boolean; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null)
  useFrame((_, dt) => { if (on && g.current) g.current.rotation.y += dt * 0.35 })
  return <group ref={g}>{children}</group>
}

function MolScene({ mol, style, labels }: { mol: MolT; style: Style; labels: boolean }) {
  const c = useMemo(() => {
    const n = mol.atoms.length || 1
    return [mol.atoms.reduce((s, a) => s + a.x, 0) / n, mol.atoms.reduce((s, a) => s + a.y, 0) / n, mol.atoms.reduce((s, a) => s + a.z, 0) / n]
  }, [mol])
  return (
    <group position={[-c[0], -c[1], -c[2]]}>
      <Atoms atoms={mol.atoms} style={style} />
      <Bonds atoms={mol.atoms} bonds={mol.bonds} style={style} />
      {(mol.hbonds ?? []).map((h, i) => {
        const a = mol.atoms[h.a], b = mol.atoms[h.b]
        return a && b ? <Line key={i} points={[[a.x, a.y, a.z], [b.x, b.y, b.z]]} color="#22d3ee" lineWidth={2} dashed dashSize={0.18} gapSize={0.14} /> : null
      })}
      {labels && mol.atoms.length <= 120 && mol.atoms.map((a, i) => a.el !== 'H' && (
        <Html key={i} position={[a.x, a.y, a.z]} center style={{ pointerEvents: 'none' }}><span className="rounded bg-black/55 px-0.5 text-[9px] font-semibold text-white">{a.el}{i}</span></Html>
      ))}
    </group>
  )
}

function AggScene({ agg }: { agg: AggT }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const mat = new THREE.Matrix4(), col = new THREE.Color()
    agg.particles.forEach((p, i) => {
      mat.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1))
      m.setMatrixAt(i, mat)
      m.setColorAt(i, col.set(p.state === 'aggregated' ? '#e11d48' : '#94a3b8'))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [agg])
  return <instancedMesh key={agg.particles.length} ref={ref} args={[undefined, undefined, agg.particles.length]}><sphereGeometry args={[1, 16, 12]} /><meshStandardMaterial roughness={0.5} /></instancedMesh>
}

export default function Molecules() {
  const { toast, dark } = useStore()
  const [cat, setCat] = useState<{ key: string; name: string; class: string }[]>([])
  const [mode, setMode] = useState<Mode>({ kind: 'molecule', key: 'glucose' })
  const [mol, setMol] = useState<MolT | null>(null)
  const [fileMol, setFileMol] = useState<MolT | null>(null)
  const [agg, setAgg] = useState<AggT | null>(null)
  const [style, setStyle] = useState<Style>('ballstick')
  const [labels, setLabels] = useState(false)
  const [spin, setSpin] = useState(true)
  const [busy, setBusy] = useState(false)
  const [hydMol, setHydMol] = useState('glutamic_acid')
  const [order, setOrder] = useState(1)
  const [T, setT] = useState(85)
  const [time, setTime] = useState(300)
  const [mats, setMats] = useState<Material[]>([])
  const [aggMat, setAggMat] = useState('mat-pea-protein-isolate')
  const [emul, setEmul] = useState({ radius_um: 2, gamma_mN_m: 10, rho_d: 920, rho_c: 1000, mu_c: 0.001 })
  const [emulRes, setEmulRes] = useState<{ laplace_pressure_pa: number; stokes_velocity_m_s: number; assumptions: string } | null>(null)

  useEffect(() => { api.get<typeof cat>('/api/molecules').then(setCat); api.get<Material[]>('/api/materials').then(setMats) }, [])
  useEffect(() => {
    setBusy(true)
    setAgg(null)
    let p: Promise<unknown>
    if (mode.kind === 'molecule') p = api.get<MolT>(`/api/molecules/${mode.key}`).then(setMol)
    else if (mode.kind === 'file') { setMol(fileMol); p = Promise.resolve() }
    else if (mode.name === 'aggregation') p = api.get<AggT>(`/api/molecular-scenes/aggregation?temperature_c=${T}&time_s=${time}&material_id=${aggMat}`).then((a) => { setAgg(a); setMol(null) })
    else if (mode.name === 'emulsion') { setMol(null); p = api.post<typeof emulRes>('/api/molecular-scenes/emulsion', emul).then(setEmulRes) }
    else p = api.get<MolT>(`/api/molecular-scenes/${mode.name}?molecule=${hydMol}&order=${order}`).then(setMol)
    p.catch((e) => toast((e as Error).message, 'error')).finally(() => setBusy(false))
  }, [JSON.stringify(mode), hydMol, order, T, time, aggMat, JSON.stringify(emul)])  // eslint-disable-line react-hooks/exhaustive-deps

  const loadFile = async () => {
    try {
      const f = await pickFile('.pdb,.ent,.sdf,.mol,.xyz')
      const m = await api.upload<MolT>('/api/molecules/parse', f, f.name)
      setFileMol(m)
      setMode({ kind: 'file' })
      setMol(m)
      if (m.atoms.length > 2000) setStyle('sticks')
      log('success', 'molecules', `Loaded ${f.name}: ${m.atoms.length} atoms, ${m.bonds.length} bonds`)
    } catch (e) {
      if ((e as Error).message !== 'No file selected') toast((e as Error).message, 'error')
    }
  }

  const sceneKind = mode.kind === 'scene' ? (agg?.kind ?? mol?.kind ?? (mode.name === 'emulsion' ? 'calculated' : 'conceptual')) : 'computed structure'
  const equations = useMemo(() => {
    if (mode.kind !== 'scene') return [{ title: 'Molar mass', latex: 'M = \\sum_i n_i\\,A_{r,i}\\;\\mathrm{g\\,mol^{-1}}', note: 'Exact for the structure (IUPAC standard atomic weights).' }]
    switch (mode.name) {
      case 'water': return [{ title: 'Hydrogen bond (schematic)', latex: '\\mathrm{O{-}H\\cdots O}\\quad d_{\\mathrm{O\\cdots O}} \\approx 2.76\\,\\text{Å (ice I}_h)', note: 'Geometric description, not an energy model.' }]
      case 'hydration': return [{ title: 'Hydrogen bonding to polar groups', latex: '\\mathrm{R{-}COO^- \\cdots H{-}O{-}H},\\quad \\mathrm{R{-}NH_3^+ \\cdots OH_2}', note: 'Schematic interactions.' }]
      case 'starch': return [{ title: 'Degree of gelatinisation (general first-order form)', latex: '\\alpha(t) = 1 - \\exp\\!\\big(-k(T)\\,t\\big),\\quad k(T)=k_{ref}\\,e^{-\\frac{E_a}{R}\\left(\\frac1T-\\frac1{T_{ref}}\\right)}', note: 'General form only; no parameters are applied unless an approved model exists.' }]
      case 'aggregation': return [{ title: 'Denaturation kinetics (first order)', latex: 'X(t) = 1 - \\exp\\!\\big(-k(T)\\,t\\big)', status: agg?.model_id ? 'approved model' : 'not parameterised', note: agg?.model_id ? `Evaluated with registry model ${agg.model_id}.` : 'No approved model for this material.' }]
      case 'emulsion': return [{ title: 'Laplace pressure', latex: '\\Delta P = \\dfrac{2\\gamma}{r}' }, { title: "Stokes' law (creaming / sedimentation)", latex: 'v = \\dfrac{2\\,(\\rho_d-\\rho_c)\\,g\\,r^2}{9\\,\\mu_c}' }]
    }
  }, [mode, agg?.model_id])
  useEquations(equations, [JSON.stringify(equations)])

  const sceneBtn = (name: 'water' | 'hydration' | 'starch' | 'aggregation' | 'emulsion', label: string) => (
    <button onClick={() => setMode({ kind: 'scene', name })} className={cx('w-full rounded px-2 py-1 text-left text-xs', mode.kind === 'scene' && mode.name === name ? 'bg-rose-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>{label}</button>
  )

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Molecular structures & interactions" subtitle="Computed 3D conformers (RDKit), user structure files, and qualified interaction scenes. Conceptual illustrations are labelled as such; only model-driven quantities are predictions."
        actions={<Button size="sm" onClick={loadFile}><FileUp className="h-3.5 w-3.5" />Load PDB / SDF / MOL / XYZ</Button>} />
      <div className="grid min-h-0 flex-1 gap-3 @4xl:grid-cols-[210px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <Panel title="Molecules" bodyClass="p-1">
            {['solvent', 'sugar', 'carbohydrate', 'lipid component', 'lipid', 'amino acid', 'peptide'].map((cls) => {
              const items = cat.filter((c) => c.class === cls)
              return items.length ? (
                <div key={cls}>
                  <div className="px-2 pt-1 text-[9.5px] font-semibold uppercase tracking-wider text-neutral-400">{cls}</div>
                  {items.map((c) => <button key={c.key} onClick={() => setMode({ kind: 'molecule', key: c.key })} className={cx('w-full rounded px-2 py-0.5 text-left text-xs', mode.kind === 'molecule' && mode.key === c.key ? 'bg-rose-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>{c.name}</button>)}
                </div>
              ) : null
            })}
            {fileMol && <button onClick={() => setMode({ kind: 'file' })} className={cx('mt-1 w-full rounded px-2 py-0.5 text-left text-xs', mode.kind === 'file' ? 'bg-rose-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-white/5')}>📄 {fileMol.name}</button>}
          </Panel>
          <Panel title="Interaction scenes" bodyClass="p-1">
            {sceneBtn('water', 'Water hydrogen-bond network')}
            {sceneBtn('hydration', 'Protein / amino-acid hydration')}
            {sceneBtn('aggregation', 'Protein aggregation & gel network')}
            {sceneBtn('starch', 'Starch gelatinisation')}
            {sceneBtn('emulsion', 'Emulsion droplet physics')}
          </Panel>
        </div>

        <div className="relative min-h-[420px] overflow-hidden rounded border border-neutral-300 dark:border-white/10">
          <div className="absolute left-2 top-2 z-10 flex flex-wrap gap-1">
            {(['ballstick', 'sticks', 'spacefill'] as Style[]).map((s) => <button key={s} onClick={() => setStyle(s)} className={cx('rounded px-2 py-0.5 text-[11px]', style === s ? 'bg-rose-600 text-white' : 'bg-black/60 text-neutral-200 hover:bg-black/80')}>{s === 'ballstick' ? 'Ball & stick' : s === 'spacefill' ? 'Space-filling (vdW)' : 'Sticks'}</button>)}
            <button onClick={() => setLabels(!labels)} className={cx('rounded px-2 py-0.5 text-[11px]', labels ? 'bg-rose-600 text-white' : 'bg-black/60 text-neutral-200')}>Labels</button>
            <button onClick={() => setSpin(!spin)} className="rounded bg-black/60 px-2 py-0.5 text-[11px] text-neutral-200">{spin ? <Pause className="inline h-3 w-3" /> : <RotateCw className="inline h-3 w-3" />} {spin ? 'Stop' : 'Rotate'}</button>
          </div>
          <div className="absolute right-2 top-2 z-10">
            <span className={cx('rounded px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide', sceneKind === 'conceptual' ? 'bg-amber-500 text-black' : sceneKind === 'model-driven' || sceneKind === 'calculated' ? 'bg-cyan-500 text-black' : 'bg-emerald-500 text-black')}>
              {sceneKind === 'conceptual' ? 'Conceptual illustration' : sceneKind === 'model-driven' ? 'Model-driven (approved model)' : sceneKind}
            </span>
          </div>
          {busy && <div className="absolute bottom-2 left-2 z-10"><Spinner label="Computing…" /></div>}
          {mode.kind === 'scene' && mode.name === 'emulsion' ? (
            <EmulsionView r={emul.radius_um} />
          ) : (
            <Canvas camera={{ position: [0, 0, agg ? 90 : 26], fov: 40 }} dpr={[1, 2]} style={{ background: dark ? 'radial-gradient(#1f232a, #0b0c0f)' : 'radial-gradient(#ffffff, #dfe3e8)' }}>
              <ambientLight intensity={0.6} />
              <directionalLight position={[20, 30, 25]} intensity={1.2} />
              <directionalLight position={[-20, -10, -10]} intensity={0.35} color="#9ad7ff" />
              <Spin on={spin}>
                {mol && <MolScene mol={mol} style={style} labels={labels} />}
                {agg && <AggScene agg={agg} />}
              </Spin>
              <OrbitControls makeDefault enableDamping />
            </Canvas>
          )}
        </div>
      </div>

      <Inspector>
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500"><Atom className="h-3.5 w-3.5" />{mol?.title ?? agg?.title ?? mol?.name ?? 'Emulsion droplet'}</div>
          {mode.kind !== 'scene' && mol?.properties && (
            <>
              <KV rows={Object.entries(mol.properties).map(([k, v]) => [k.replace(/_/g, ' '), typeof v === 'number' ? fmtSci(v, 6) : v])} />
              <p className="text-[10.5px] text-neutral-500">{mol.property_note}</p>
              {mol.smiles && <div className="break-all text-[10.5px] text-neutral-500">SMILES: <code>{mol.smiles}</code></div>}
              <div className="text-[10.5px] text-neutral-500">{mol.atoms.length} atoms · {mol.bonds.length} bonds</div>
            </>
          )}
          {mode.kind === 'scene' && mode.name === 'hydration' && (
            <Field label="Molecule"><Select value={hydMol} onChange={(e) => setHydMol(e.target.value)}>{cat.filter((c) => ['amino acid', 'peptide', 'sugar'].includes(c.class)).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</Select></Field>
          )}
          {mode.kind === 'scene' && mode.name === 'starch' && (
            <Field label={`Structural order (illustrative): ${order.toFixed(2)}`}><input type="range" min={0} max={1} step={0.05} value={order} onChange={(e) => setOrder(Number(e.target.value))} className="w-full" /></Field>
          )}
          {mode.kind === 'scene' && mode.name === 'aggregation' && (
            <>
              <Field label="Material (approved kinetics model looked up)"><Select value={aggMat} onChange={(e) => setAggMat(e.target.value)}>{mats.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
              <div className="grid grid-cols-2 gap-1.5">
                <Field label="Temperature [°C]"><NumInput value={T} allowNull={false} onChange={(v) => setT(v ?? 85)} /></Field>
                <Field label="Holding time [s]"><NumInput value={time} allowNull={false} onChange={(v) => setTime(v ?? 300)} /></Field>
              </div>
              {agg && (agg.denatured_fraction !== null ? <div className="rounded bg-cyan-50 p-2 dark:bg-cyan-950/30">Denatured fraction X = <b className="num">{fmtSci(agg.denatured_fraction, 4)}</b> <Badge tone="green">predicted</Badge></div>
                : <Alert kind="warn">No approved denaturation-kinetics model for this material — temperature and time changes are not translated into predictions.</Alert>)}
            </>
          )}
          {mode.kind === 'scene' && mode.name === 'emulsion' && (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <Field label="Droplet radius r [µm]"><NumInput value={emul.radius_um} allowNull={false} onChange={(v) => setEmul({ ...emul, radius_um: v ?? 1 })} /></Field>
                <Field label="Interfacial tension γ [mN/m]"><NumInput value={emul.gamma_mN_m} allowNull={false} onChange={(v) => setEmul({ ...emul, gamma_mN_m: v ?? 10 })} /></Field>
                <Field label="Droplet density ρd [kg/m³]"><NumInput value={emul.rho_d} allowNull={false} onChange={(v) => setEmul({ ...emul, rho_d: v ?? 920 })} /></Field>
                <Field label="Continuous density ρc [kg/m³]"><NumInput value={emul.rho_c} allowNull={false} onChange={(v) => setEmul({ ...emul, rho_c: v ?? 1000 })} /></Field>
                <Field label="Continuous viscosity μc [Pa·s]" className="col-span-2"><NumInput value={emul.mu_c} allowNull={false} onChange={(v) => setEmul({ ...emul, mu_c: v ?? 0.001 })} /></Field>
              </div>
              {emulRes && (
                <div className="rounded bg-cyan-50 p-2 dark:bg-cyan-950/30">
                  <div>Laplace pressure ΔP = <b className="num">{fmtSci(emulRes.laplace_pressure_pa, 4)}</b> Pa</div>
                  <div>Stokes velocity v = <b className="num">{fmtSci(emulRes.stokes_velocity_m_s * 1000 * 3600, 4)}</b> mm/h ({emulRes.stokes_velocity_m_s < 0 ? 'creaming (upward)' : 'sedimentation'})</div>
                  <div className="mt-1 text-[10px] text-neutral-500">{emulRes.assumptions} Inputs are user values; take densities/viscosity from approved library records where available.</div>
                </div>
              )}
            </>
          )}
          <div className="rounded border border-neutral-200 p-2 text-[11px] dark:border-white/10"><b>Provenance:</b> {mode.kind === 'scene' ? (agg?.provenance ?? mol?.provenance ?? 'Calculated from textbook relations with the inputs above.') : mol?.provenance}</div>
          {(mol?.facts ?? agg?.facts)?.length ? <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-neutral-600 dark:text-neutral-400">{(mol?.facts ?? agg?.facts)!.map((f, i) => <li key={i}>{f}</li>)}</ul> : null}
          <p className="text-[10px] text-neutral-500">No molecular-dynamics trajectories are generated. Structures for proteins can be loaded from PDB files when experimentally determined structures are available.</p>
        </div>
      </Inspector>
    </div>
  )
}

function EmulsionView({ r }: { r: number }) {
  const [t, setT] = useState(0)
  useEffect(() => { const h = setInterval(() => setT((x) => x + 1), 60); return () => clearInterval(h) }, [])
  const R = Math.min(140, 40 + r * 12)
  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-b from-sky-50 to-sky-100 dark:from-[#10161c] dark:to-[#0b0f13]">
      <svg viewBox="-200 -200 400 400" className="h-full max-h-[520px] w-full">
        <defs><radialGradient id="oil" cx="35%" cy="35%"><stop offset="0" stopColor="#fde68a" /><stop offset="1" stopColor="#d97706" /></radialGradient></defs>
        <circle r={R} fill="url(#oil)" opacity={0.95} />
        {Array.from({ length: 36 }).map((_, i) => {
          const a = (i / 36) * Math.PI * 2 + t * 0.004
          return <g key={i} transform={`rotate(${(a * 180) / Math.PI})`}><line x1={R - 10} x2={R + 4} y1={0} y2={0} stroke="#78350f" strokeWidth={2} /><circle cx={R + 8} cy={0} r={5} fill="#0891b2" /></g>
        })}
        <text y={R + 40} textAnchor="middle" className="fill-neutral-600 text-[11px] dark:fill-neutral-300">Oil droplet stabilised by an adsorbed emulsifier layer (schematic)</text>
      </svg>
    </div>
  )
}
