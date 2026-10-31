import type { Paper } from './Papers'

export function ExtractionReview(_: { paper: Paper; onSource: (page: number, snippet?: string | null) => void; page: number; highlight: string | null; onPage: (n: number) => void; onChanged: () => void }) {
  void _
  return <p className="p-3 text-xs text-neutral-500">Extraction is implemented in the next milestone.</p>
}
