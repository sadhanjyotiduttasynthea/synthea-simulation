import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowRightLeft, Container, Cog, Copy, Flame, Gauge, Package, Play, Save, Snowflake, Trash2, Waves, Wind, Workflow } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Alert, Button, Field, Input, KV, NumInput, PageHeader, Panel, Prov, Select, Spinner, Stat, cx } from '../components/ui'
import { api } from '../lib/api'
import { eur, fmt, fmtSci } from '../lib/format'
import { useActiveFormulation, useResults, useStore } from '../store'

type UnitData = { kind: string; label: string; params: Record<string, number>; result?: UnitResult }
type UnitNode = Node<UnitData, 'unit'>
interface UnitResult { id: string; kind: string; label: string; outputs: Record<string, number | null>; warnings: string[]; unsupported: string[] }
interface SimResult {
  order: string[]; units: UnitResult[]; warnings: string[]; disclaimer: string; rheology_available: boolean; formulation_cost_per_kg: number | null
  summary: Record<string, number | null | string>
}
interface Flow { id?: string; project_id: string; name: string; nodes: UnitNode[]; edges: Edge[] }

const ICONS: Record<string, typeof Cog> = { storage: Container, mixer: Cog, heater: Flame, cooler: Snowflake, pump: Gauge, pipe: ArrowRightLeft, extruder: Wind, conveyor: Waves, packaging: Package }

const PARAM_LABELS: Record<string, string> = {
  mass_flow_kg_h: 'Feed mass flow [kg/h]', temperature_c: 'Feed temperature [°C]', volume_l: 'Volume [L]', fill_fraction: 'Fill fraction [–]', power_kw: 'Power [kW]',
  outlet_temperature_c: 'Outlet temperature [°C]', efficiency: 'Efficiency [–]', cop: 'Coefficient of performance [–]', pressure_rise_bar: 'Pressure rise [bar]',
  length_m: 'Length [m]', diameter_mm: 'Inner diameter [mm]', barrel_temperature_c: 'Barrel temperature [°C]', sme_kwh_t: 'Specific mechanical energy [kWh/t] (input)',
  free_volume_l: 'Free barrel volume [L]', moisture_loss_pct: 'Moisture flash-off [% of feed] (input)', die_diameter_mm: 'Die diameter [mm]', die_length_mm: 'Die length [mm]', die_count: 'Number of die holes',
  speed_m_min: 'Belt speed [m/min]', pack_size_g: 'Pack size [g]',
}
const OUT_LABELS: Record<string, [string, string, number?]> = {
  inlet_mass_flow_kg_h: ['Inlet mass flow', 'kg/h'], outlet_mass_flow_kg_h: ['Outlet mass flow', 'kg/h'], inlet_temperature_c: ['Inlet temperature', '°C', 1], outlet_temperature_c: ['Outlet temperature', '°C', 1],
  density_kg_m3: ['Density', 'kg/m³', 0], specific_heat_kj_kgk: ['Specific heat', 'kJ/(kg·K)', 3], volumetric_flow_l_h: ['Volumetric flow', 'L/h', 1], mean_residence_time_s: ['Mean residence time', 's', 1],
  adiabatic_temperature_rise_k: ['Adiabatic ΔT (mixing)', 'K', 2], heat_duty_kw: ['Heat duty', 'kW', 2], energy_input_kw: ['Energy input', 'kW', 2], heat_removed_kw: ['Heat removed', 'kW', 2],
  shaft_power_kw: ['Shaft power', 'kW', 3], hydraulic_power_kw: ['Hydraulic power', 'kW', 3], mean_velocity_m_s: ['Mean velocity', 'm/s', 3], pressure_drop_bar: ['Pressure drop', 'bar', 3],
  wall_shear_rate_1_s: ['Wall shear rate', '1/s', 1], plug_radius_mm: ['Plug radius', 'mm', 2], mechanical_power_kw: ['Mechanical power (SME)', 'kW', 2], sensible_heat_to_barrel_temp_kw: ['Sensible heat to barrel T', 'kW', 2],
  barrel_heating_needed_kw: ['Barrel heating needed', 'kW', 2], moisture_flash_off_kg_h: ['Moisture flash-off', 'kg/h', 2], latent_heat_flash_kw: ['Latent heat of flash-off', 'kW', 2],
  die_pressure_drop_bar: ['Die pressure drop', 'bar', 2], die_wall_shear_rate_1_s: ['Die wall shear rate', '1/s', 0], residence_time_s: ['Residence time', 's', 0], packs_per_hour: ['Packs per hour', '1/h', 0],
  electrical_power_kw: ['Electrical power', 'kW', 2], temperature_change_k: ['Temperature change', 'K', 1], mass_change_kg_h: ['Mass change', 'kg/h', 2],
}

function UnitNodeView({ data, selected }: NodeProps<UnitNode>) {
  const Icon = ICONS[data.kind] ?? Cog
  const r = data.result?.outputs
  return (
    <div className={cx('w-40 rounded border bg-white text-left shadow-sm dark:bg-neutral-900', selected ? 'border-accent' : 'border-neutral-300 dark:border-neutral-700', data.result?.unsupported.length ? 'border-b-4 border-b-amber-400' : '')}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-neutral-500 !bg-white" />
      <div className="flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1 dark:border-neutral-700">
        <Icon className="h-3.5 w-3.5 text-accent" />
        <span className="truncate text-[11px] font-semibold">{data.label}</span>
      </div>
      <div className="px-2 py-1 text-[10px] text-neutral-500">
        <div className="uppercase tracking-wide">{data.kind}</div>
        {r && (
          <div className="num mt-0.5 space-y-px text-neutral-700 dark:text-neutral-300">
            <div>{fmt(r.outlet_mass_flow_kg_h, 1)} kg/h · {fmt(r.outlet_temperature_c, 1)} °C</div>
            {r.electrical_power_kw ? <div>{fmt(r.electrical_power_kw, 2)} kW</div> : null}
            {r.mean_residence_time_s !== undefined && r.mean_residence_time_s !== null && <div>τ {fmt(r.mean_residence_time_s, 1)} s</div>}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-neutral-500 !bg-accent" />
    </div>
  )
}
const nodeTypes = { unit: UnitNodeView }

export default function Process() {
  return (
    <ReactFlowProvider>
      <ProcessInner />
    </ReactFlowProvider>
  )
}

function ProcessInner() {
  const { project, formulations, toast, setAssistant, setResult, dark } = useStore()
  const results = useResults()
  const active = useActiveFormulation()
  const rf = useReactFlow()
  const [library, setLibrary] = useState<Record<string, { label: string; params: Record<string, number> }>>({})
  const [flows, setFlows] = useState<Flow[]>([])
  const [flowId, setFlowId] = useState<string | undefined>()
  const [flowName, setFlowName] = useState('Process flow')
  const [nodes, setNodes, onNodesChange] = useNodesState<UnitNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [formId, setFormId] = useState<string | undefined>(active?.id)
  const [energyPrice, setEnergyPrice] = useState(project?.settings.energy_price_eur_kwh ?? 0.2)
  const [useRheo, setUseRheo] = useState(true)
  const [sim, setSim] = useState<SimResult | null>((results.process as SimResult) ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const form = formulations.find((f) => f.id === formId) ?? active

  const loadFlow = useCallback((f: Flow) => {
    setFlowId(f.id)
    setFlowName(f.name)
    setNodes(f.nodes.map((n) => ({ ...n, type: 'unit', data: { ...n.data, result: undefined } })))
    setEdges(f.edges.map((e) => ({ ...e, animated: true })))
    setSelected(null)
    setTimeout(() => rf.fitView({ padding: 0.15 }), 50)
  }, [setNodes, setEdges, rf])

  useEffect(() => {
    if (!project) return
    api.get<typeof library>('/api/process/units').then(setLibrary)
    api.get<Flow[]>(`/api/process-flows?project_id=${project.id}`).then((fs) => {
      setFlows(fs)
      if (fs[0]) loadFlow(fs[0])
    })
  }, [project?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setFormId(active?.id)
  }, [active?.id])
  useEffect(() => {
    setAssistant('process', { process: sim })
  }, [sim, setAssistant])

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, animated: true }, es)), [setEdges])

  const addUnit = (kind: string, pos?: { x: number; y: number }) => {
    const lib = library[kind]
    if (!lib) return
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`
    const position = pos ?? { x: 80 + nodes.length * 30, y: 320 + (nodes.length % 3) * 20 }
    setNodes((ns) => [...ns, { id, type: 'unit', position, data: { kind, label: lib.label, params: { ...lib.params } } }])
    setSelected(id)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const kind = e.dataTransfer.getData('application/synthea-unit')
    if (kind) addUnit(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  const toFlow = (): Flow => ({
    id: flowId, project_id: project!.id, name: flowName,
    nodes: nodes.map((n) => ({ id: n.id, type: 'unit', position: n.position, data: { kind: n.data.kind, label: n.data.label, params: n.data.params } })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  })

  const saveFlow = async (asNew = false) => {
    const f = toFlow()
    if (asNew) {
      delete f.id
      f.name = `${f.name} (copy)`
    }
    const s = await api.post<Flow>('/api/process-flows', f)
    const fs = await api.get<Flow[]>(`/api/process-flows?project_id=${project!.id}`)
    setFlows(fs)
    setFlowId(s.id)
    setFlowName(s.name)
    toast(asNew ? 'Flow duplicated' : 'Process flow saved', 'success')
  }
  const deleteFlow = async () => {
    if (!flowId || !confirm(`Delete flow "${flowName}"?`)) return
    await api.del(`/api/process-flows/${flowId}`)
    const fs = await api.get<Flow[]>(`/api/process-flows?project_id=${project!.id}`)
    setFlows(fs)
    if (fs[0]) loadFlow(fs[0])
    else { setNodes([]); setEdges([]); setFlowId(undefined) }
  }

  const run = async () => {
    if (!form) return toast('Select a formulation first', 'error')
    setBusy(true)
    setErr(null)
    try {
      const rheo = useRheo && form.rheology && form.rheology.yield_stress_pa !== null ? { ...form.rheology, source: `${form.rheology.data_type ?? 'user'}: ${form.rheology.source || 'formulation record'}` } : null
      const r = await api.post<SimResult>('/api/process/simulate', { flow: toFlow(), lines: form.lines, energy_price_eur_kwh: energyPrice, rheology: rheo })
      setSim(r)
      setResult('process', { ...r, formulation: form.name, flow: flowName })
      setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, result: r.units.find((u) => u.id === n.id) } })))
      toast('Process simulation complete', 'success')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sel = nodes.find((n) => n.id === selected)
  const updateSel = (patch: Partial<UnitData>) => setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, ...patch } } : n)))
  const s = sim?.summary
  const profile = useMemo(() => {
    if (!sim) return []
    const pts: { name: string; T: number | null; m: number | null }[] = []
    for (const u of sim.units) {
      pts.push({ name: u.label, T: u.outputs.outlet_temperature_c ?? null, m: u.outputs.outlet_mass_flow_kg_h ?? null })
    }
    return pts
  }, [sim])

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Process Simulator"
        subtitle="Virtual pilot factory: steady-state lumped mass & energy balances with Choi–Okos properties and Herschel–Bulkley flow (no CFD)."
        actions={<>
          <Select className="w-52" value={flowId ?? ''} onChange={(e) => { const f = flows.find((x) => x.id === e.target.value); if (f) loadFlow(f) }}>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            {!flowId && <option value="">(unsaved flow)</option>}
          </Select>
          <Button size="sm" onClick={() => saveFlow(false)}><Save className="h-3.5 w-3.5" />Save flow</Button>
          <Button size="sm" onClick={() => saveFlow(true)}><Copy className="h-3.5 w-3.5" />Save as</Button>
          <Button size="sm" variant="ghost" onClick={deleteFlow} disabled={!flowId}><Trash2 className="h-3.5 w-3.5" /></Button>
          <Button variant="primary" onClick={run} loading={busy}><Play className="h-3.5 w-3.5" />Run simulation</Button>
        </>}
      />
      <div className="grid gap-3 @5xl:min-h-0 @5xl:flex-1 @5xl:grid-cols-[200px_minmax(0,1fr)_310px]">
        <div className="space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          <Panel title="Equipment library" bodyClass="p-1.5 grid grid-cols-2 gap-1 @5xl:grid-cols-1">
            {Object.entries(library).map(([kind, l]) => {
              const Icon = ICONS[kind] ?? Cog
              return (
                <div key={kind} draggable onDragStart={(e) => { e.dataTransfer.setData('application/synthea-unit', kind); e.dataTransfer.effectAllowed = 'move' }}
                  onDoubleClick={() => addUnit(kind)}
                  className="flex cursor-grab items-center gap-2 rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs hover:border-neutral-500 active:cursor-grabbing dark:border-neutral-700 dark:bg-neutral-800">
                  <Icon className="h-3.5 w-3.5 text-accent" /><span className="flex-1">{l.label}</span>
                  <button onClick={() => addUnit(kind)} className="text-neutral-400 hover:text-neutral-900 dark:hover:text-white" title="Add">+</button>
                </div>
              )
            })}
            <p className="col-span-full px-1 pt-1 text-[10px] text-neutral-500">Drag onto the canvas (or click +). Connect outlet (red) → inlet. Select and press Delete/Backspace to remove.</p>
          </Panel>
          <Panel title="Material stream">
            <Field label="Formulation">
              <Select value={form?.id ?? ''} onChange={(e) => setFormId(e.target.value)}>{formulations.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
            </Field>
            <div className="mt-2 text-[11px]">
              Rheology: {form?.rheology?.yield_stress_pa !== null && form?.rheology ? <><Prov kind={form.rheology.data_type} /> τ₀={form.rheology.yield_stress_pa} Pa, K={form.rheology.consistency_index_pa_sn}, n={form.rheology.flow_behaviour_index}</> : <Prov kind="missing" />}
            </div>
            <label className="mt-1 flex items-center gap-1.5 text-[11px]"><input type="checkbox" checked={useRheo} onChange={(e) => setUseRheo(e.target.checked)} />Use formulation rheology for pressure drops</label>
            <Field label="Electricity price [€/kWh] (illustrative)" className="mt-2"><NumInput value={energyPrice} allowNull={false} onChange={(v) => setEnergyPrice(v ?? 0.2)} /></Field>
          </Panel>
        </div>

        <div className="@container flex flex-col gap-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          <div className="h-[420px] shrink-0 overflow-hidden rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} onDrop={onDrop}>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} fitView deleteKeyCode={['Delete', 'Backspace']}
              colorMode={dark ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="!h-20 !w-32" />
            </ReactFlow>
          </div>
          {err && <Alert kind="error" title="Simulation failed">{err}</Alert>}
          {busy && <Spinner label="Solving mass and energy balances…" />}
          {sim && s && (
            <>
              <div className="grid grid-cols-2 gap-2 @@5xl:grid-cols-4">
                <Stat label="Feed → product" value={`${fmt(s.feed_kg_h as number, 1)} → ${fmt(s.product_kg_h as number, 1)}`} unit="kg/h" sub={`evaporated ${fmt(s.evaporated_kg_h as number, 2)} kg/h`} prov="calculated" />
                <Stat label="Total electrical power" value={fmt(s.total_power_kw as number, 2)} unit="kW" />
                <Stat label="Specific energy" value={fmt(s.specific_energy_kwh_per_kg_product as number, 3)} unit="kWh/kg" />
                <Stat label="Operating cost" value={eur(s.operating_cost_eur_per_kg_product as number, 3)} unit="/kg product" sub={`energy ${eur(s.energy_cost_eur_h as number)}/h · material ${eur(s.material_cost_eur_h as number)}/h`} tone="red" />
              </div>
              <div className="grid gap-3 @3xl:grid-cols-2">
                <Panel title="Temperature and mass flow along the line">
                  <div className="h-52">
                    <ResponsiveContainer>
                      <LineChart data={profile}>
                        <CartesianGrid strokeDasharray="2 4" />
                        <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" height={45} />
                        <YAxis yAxisId="T" tick={{ fontSize: 10 }} label={{ value: '°C', angle: -90, position: 'insideLeft', fontSize: 10 }} />
                        <YAxis yAxisId="m" orientation="right" tick={{ fontSize: 10 }} domain={['auto', 'auto']} label={{ value: 'kg/h', angle: 90, position: 'insideRight', fontSize: 10 }} />
                        <Tooltip formatter={(v) => fmt(Number(v), 2)} />
                        <Line yAxisId="T" dataKey="T" name="Outlet T [°C]" stroke="#b91c1c" isAnimationActive={false} />
                        <Line yAxisId="m" dataKey="m" name="Mass flow [kg/h]" stroke="#525252" strokeDasharray="4 3" isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
                <Panel title="Electrical power by unit [kW]">
                  <div className="h-52">
                    <ResponsiveContainer>
                      <BarChart data={sim.units.map((u) => ({ name: u.label, P: u.outputs.electrical_power_kw ?? 0 }))}>
                        <CartesianGrid strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" height={45} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v) => `${fmt(Number(v), 3)} kW`} />
                        <Bar dataKey="P" fill="#b91c1c" isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
              </div>
              <Panel title="Unit results" bodyClass="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full whitespace-nowrap text-xs">
                    <thead className="bg-neutral-50 text-[10px] uppercase text-neutral-500 dark:bg-neutral-900"><tr><th className="px-2 py-1 text-left">Unit</th><th className="text-right">ṁ out kg/h</th><th className="text-right">T out °C</th><th className="text-right">ρ kg/m³</th><th className="text-right">cp</th><th className="text-right">τ s</th><th className="text-right">P kW</th><th className="text-right">ΔP bar</th><th className="px-2 text-left">Status</th></tr></thead>
                    <tbody>
                      {sim.units.map((u) => (
                        <tr key={u.id} onClick={() => setSelected(u.id)} className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/40">
                          <td className="px-2 py-1 font-medium">{u.label}</td>
                          <td className="num text-right">{fmt(u.outputs.outlet_mass_flow_kg_h, 2)}</td>
                          <td className="num text-right">{fmt(u.outputs.outlet_temperature_c, 1)}</td>
                          <td className="num text-right">{fmt(u.outputs.density_kg_m3, 0)}</td>
                          <td className="num text-right">{fmt(u.outputs.specific_heat_kj_kgk, 3)}</td>
                          <td className="num text-right">{fmt(u.outputs.mean_residence_time_s ?? u.outputs.residence_time_s, 1)}</td>
                          <td className="num text-right">{fmt(u.outputs.electrical_power_kw, 3)}</td>
                          <td className="num text-right">{fmt(u.outputs.pressure_drop_bar ?? u.outputs.die_pressure_drop_bar, 3)}</td>
                          <td className="px-2">{u.unsupported.length ? <span className="text-amber-600">⚠ {u.unsupported.length} unsupported</span> : <span className="text-neutral-400">ok</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <p className="text-[10px] text-neutral-500">{sim.disclaimer} Excludes: {s.excludes as string}. Mass-balance closure error: {fmtSci(s.mass_balance_error_kg_h as number)} kg/h.</p>
            </>
          )}
        </div>

        <div className="space-y-3 @5xl:min-h-0 @5xl:overflow-y-auto">
          {sel ? (
            <>
              <Panel title="Unit properties" actions={<Button size="sm" variant="danger" onClick={() => { setNodes((ns) => ns.filter((n) => n.id !== sel.id)); setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id)); setSelected(null) }}><Trash2 className="h-3.5 w-3.5" />Remove</Button>}>
                <div className="space-y-2">
                  <Field label="Label"><Input value={sel.data.label} onChange={(e) => updateSel({ label: e.target.value })} /></Field>
                  <div className="text-[10px] uppercase tracking-wide text-neutral-500">Type: {sel.data.kind}</div>
                  {Object.entries(sel.data.params).map(([k, v]) => (
                    <Field key={k} label={PARAM_LABELS[k] ?? k}><NumInput value={v} allowNull={false} onChange={(nv) => updateSel({ params: { ...sel.data.params, [k]: nv ?? 0 } })} /></Field>
                  ))}
                </div>
              </Panel>
              {sel.data.result && (
                <Panel title="Unit results" actions={<Prov kind="calculated" />}>
                  <KV rows={Object.entries(sel.data.result.outputs).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => {
                    const [l, u, d] = OUT_LABELS[k] ?? [k, '', 3]
                    return [l, `${fmt(v as number, d ?? 2)} ${u}`]
                  })} />
                  <div className="mt-2 space-y-1">
                    {sel.data.result.unsupported.map((w, i) => <Alert key={i} kind="warn" title="Not supported">{w}</Alert>)}
                    {sel.data.result.warnings.map((w, i) => <Alert key={i}>{w}</Alert>)}
                  </div>
                </Panel>
              )}
            </>
          ) : (
            <Panel title="Flow">
              <Field label="Flow name"><Input value={flowName} onChange={(e) => setFlowName(e.target.value)} /></Field>
              <div className="mt-2 text-xs text-neutral-500">{nodes.length} units · {edges.length} connections. Select a unit to edit its settings and view its results.</div>
              <div className="mt-3 space-y-1 text-[11px] text-neutral-600 dark:text-neutral-400">
                <div className="flex items-center gap-1 font-semibold"><Workflow className="h-3.5 w-3.5" />Implemented models</div>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>Mass balance incl. extruder moisture flash-off</li><li>Mean residence time τ = V/Q</li><li>Sensible heating/cooling Q = ṁ·cp·ΔT (cp: Choi–Okos)</li>
                  <li>Pump power P = ΔP·Q/η</li><li>Herschel–Bulkley laminar pressure drop (pipe, die) when rheology is supplied</li><li>Electricity + raw-material operating cost</li>
                </ul>
              </div>
            </Panel>
          )}
          {sim?.warnings.map((w, i) => <Alert key={i} kind="warn">{w}</Alert>)}
        </div>
      </div>
    </div>
  )
}
