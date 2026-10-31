import { GraphicsView } from '../components/GraphicsView'
import { PageHeader } from '../components/ui'

export default function Geometry() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Geometry" subtitle="Graphics window (geometry editing tools arrive in milestone 6)." />
      <div className="min-h-0 flex-1">
        <GraphicsView>
          <mesh position={[0, 10, 0]}><boxGeometry args={[60, 20, 40]} /><meshStandardMaterial color="#c9a46c" /></mesh>
          <mesh position={[60, 15, 0]}><cylinderGeometry args={[15, 15, 30, 48]} /><meshStandardMaterial color="#e11d48" /></mesh>
        </GraphicsView>
      </div>
    </div>
  )
}
