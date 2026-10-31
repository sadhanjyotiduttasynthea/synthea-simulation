import { Line } from '@react-three/drei'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

export interface Atom { el: string; x: number; y: number; z: number; res?: string; chain?: string; seq?: number; name?: string; b?: number; charge?: number }
export interface TracePt { x: number; y: number; z: number; chain: string; seq: number; res: string; ss: string; b: number }
export type MolStyle = 'ballstick' | 'spacefill' | 'stick' | 'cartoon' | 'cartoon+atoms'
export type ColorBy = 'element' | 'chain' | 'ss' | 'plddt' | 'hydropathy'

const CPK: Record<string, string> = { H: '#f2f2f2', C: '#7d7d7d', N: '#3050f8', O: '#ff0d0d', S: '#e6c619', P: '#ff8000', Cl: '#1ff01f', Na: '#ab5cf2', K: '#8f40d4', Ca: '#3dff00', Mg: '#8aff00', F: '#90e050', Br: '#a62929', I: '#940094', Fe: '#e06633', Zn: '#7d80b0', Se: '#ffa100' }
const VDW: Record<string, number> = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, S: 1.8, P: 1.8, Cl: 1.75, Na: 2.27, K: 2.75, Ca: 2.31, Mg: 1.73, F: 1.47, Br: 1.85, I: 1.98 }
const CHAIN = ['#e11d48', '#0891b2', '#16a34a', '#f59e0b', '#7c3aed', '#db2777', '#0d9488', '#ea580c']
const KD: Record<string, number> = { A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5, G: -0.4, H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6, S: -0.8, T: -0.7, W: -0.9, Y: -1.3, V: 4.2 }
export const elementColor = (el: string) => CPK[el] ?? '#ff69b4'

function plddtColor(b: number) {
  // AlphaFold DB convention
  return b >= 90 ? '#0053d6' : b >= 70 ? '#65cbf3' : b >= 50 ? '#ffdb13' : '#ff7d45'
}
function hydroColor(r: string) {
  const v = (KD[r] ?? 0) / 4.5
  return new THREE.Color(v > 0 ? '#f59e0b' : '#0891b2').lerp(new THREE.Color('#e5e7eb'), 1 - Math.min(1, Math.abs(v))).getStyle()
}

function Atoms({ atoms, scale, opacity = 1, onReady }: { atoms: Atom[]; scale: (a: Atom) => number; opacity?: number; onReady?: () => void }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const im = ref.current
    if (!im) return
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    atoms.forEach((a, i) => {
      const s = scale(a)
      m.makeScale(s, s, s).setPosition(a.x, a.y, a.z)
      im.setMatrixAt(i, m)
      im.setColorAt(i, c.set(elementColor(a.el)))
    })
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    ;(im.material as THREE.Material).needsUpdate = true
    im.computeBoundingBox()
    im.computeBoundingSphere()
    onReady?.()
  }, [atoms, scale])  // eslint-disable-line react-hooks/exhaustive-deps
  if (!atoms.length) return null
  return (
    <instancedMesh key={atoms.length} ref={ref} args={[undefined, undefined, atoms.length]}>
      <sphereGeometry args={[1, atoms.length > 3000 ? 8 : 18, atoms.length > 3000 ? 6 : 14]} />
      <meshStandardMaterial roughness={0.35} metalness={0.05} transparent={opacity < 1} opacity={opacity} />
    </instancedMesh>
  )
}

/** Bonds as two half-cylinders, each coloured like its atom. */
function Bonds({ atoms, bonds, radius }: { atoms: Atom[]; bonds: number[][]; radius: number }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const n = bonds.length * 2
  useLayoutEffect(() => {
    const im = ref.current
    if (!im) return
    const up = new THREE.Vector3(0, 1, 0)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const c = new THREE.Color()
    let k = 0
    for (const [i, j] of bonds) {
      const a = new THREE.Vector3(atoms[i].x, atoms[i].y, atoms[i].z)
      const b = new THREE.Vector3(atoms[j].x, atoms[j].y, atoms[j].z)
      const mid = a.clone().lerp(b, 0.5)
      for (const [p, el] of [[a, atoms[i].el], [b, atoms[j].el]] as [THREE.Vector3, string][]) {
        const d = mid.clone().sub(p)
        const len = d.length()
        q.setFromUnitVectors(up, d.clone().normalize())
        m.compose(p.clone().lerp(mid, 0.5), q, new THREE.Vector3(radius, len, radius))
        im.setMatrixAt(k, m)
        im.setColorAt(k, c.set(elementColor(el)))
        k++
      }
    }
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    ;(im.material as THREE.Material).needsUpdate = true
    im.computeBoundingSphere()
  }, [atoms, bonds, radius])
  if (!n) return null
  return (
    <instancedMesh key={n} ref={ref} args={[undefined, undefined, n]}>
      <cylinderGeometry args={[1, 1, 1, 10]} />
      <meshStandardMaterial roughness={0.4} />
    </instancedMesh>
  )
}

/** Smooth tube through C-alpha atoms per chain, coloured per residue; helices drawn thicker. */
function Cartoon({ trace, colorBy, onReady }: { trace: TracePt[]; colorBy: ColorBy; onReady?: () => void }) {
  const segs = useMemo(() => {
    const chains: Record<string, TracePt[]> = {}
    trace.forEach((t) => (chains[t.chain] ??= []).push(t))
    const chainIds = Object.keys(chains)
    const out: { geo: THREE.TubeGeometry; color: string }[] = []
    chainIds.forEach((cid, ci) => {
      const pts = chains[cid]
      if (pts.length < 2) return
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, p.y, p.z)))
      // one tube piece per residue so each can be coloured
      const per = 6
      for (let i = 0; i < pts.length - 1; i++) {
        const sub = new THREE.CatmullRomCurve3(Array.from({ length: per + 1 }, (_, k) => curve.getPoint((i + k / per) / (pts.length - 1))))
        const r = pts[i].ss === 'helix' ? 0.75 : pts[i].ss === 'sheet' ? 0.6 : 0.35
        const col = colorBy === 'chain' ? CHAIN[ci % CHAIN.length] : colorBy === 'plddt' ? plddtColor(pts[i].b) : colorBy === 'hydropathy' ? hydroColor(pts[i].res)
          : pts[i].ss === 'helix' ? '#e11d48' : pts[i].ss === 'sheet' ? '#f59e0b' : '#94a3b8'
        out.push({ geo: new THREE.TubeGeometry(sub, per, r, 8, false), color: col })
      }
    })
    return out
  }, [trace, colorBy])
  useLayoutEffect(() => { onReady?.(); return () => segs.forEach((s) => s.geo.dispose()) }, [segs])  // eslint-disable-line react-hooks/exhaustive-deps
  return <group>{segs.map((s, i) => <mesh key={i} geometry={s.geo}><meshStandardMaterial color={s.color} roughness={0.5} /></mesh>)}</group>
}

export function MoleculeModel({ atoms, bonds, trace, style, colorBy = 'ss', offset, onReady }: { atoms: Atom[]; bonds: number[][]; trace?: TracePt[]; style: MolStyle; colorBy?: ColorBy; offset?: [number, number, number]; onReady?: () => void }) {
  const scale = useMemo(() => (style === 'spacefill' ? (a: Atom) => VDW[a.el] ?? 1.6 : style === 'stick' ? () => 0.18 : (a: Atom) => (a.el === 'H' ? 0.22 : 0.34)), [style])
  const showAtoms = style !== 'cartoon' || !trace?.length
  const cartoon = (style === 'cartoon' || style === 'cartoon+atoms') && !!trace?.length
  const atomOpacity = style === 'cartoon+atoms' ? 0.35 : 1
  return (
    <group position={offset}>
      {showAtoms && <Atoms atoms={atoms} scale={scale} opacity={atomOpacity} onReady={onReady} />}
      {showAtoms && style !== 'spacefill' && <Bonds atoms={atoms} bonds={bonds} radius={style === 'stick' ? 0.18 : 0.12} />}
      {cartoon && <Cartoon trace={trace!} colorBy={colorBy} onReady={showAtoms ? undefined : onReady} />}
    </group>
  )
}

export function HBondLines({ pairs }: { pairs: [THREE.Vector3, THREE.Vector3][] }) {
  return <>{pairs.map(([a, b], i) => <Line key={i} points={[a, b]} color="#06b6d4" lineWidth={2} dashed dashSize={0.25} gapSize={0.15} />)}</>
}

/** Centre of all atoms (Å) to place molecules at the origin. */
export function centroid(atoms: { x: number; y: number; z: number }[]): [number, number, number] {
  if (!atoms.length) return [0, 0, 0]
  const s = atoms.reduce((acc, a) => [acc[0] + a.x, acc[1] + a.y, acc[2] + a.z], [0, 0, 0])
  return [s[0] / atoms.length, s[1] / atoms.length, s[2] / atoms.length]
}
