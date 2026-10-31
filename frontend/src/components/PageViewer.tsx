import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * Renders a PDF page (server-side rasterisation) with highlight overlays for a supporting
 * passage. `highlight` text is located on the page with PyMuPDF text search.
 */
export function PageViewer({ paperId, page, pageCount, pageWidth, highlight, onPage }: {
  paperId: string; page: number; pageCount: number; pageWidth: number; highlight?: string | null; onPage: (n: number) => void
}) {
  const [zoom, setZoom] = useState(1.4)
  const [rects, setRects] = useState<number[][]>([])
  const [loaded, setLoaded] = useState(false)
  const [imgW, setImgW] = useState(0)
  const imgRef = useRef<HTMLImageElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setRects([])
    if (!highlight) return
    api.get<{ rects: number[][] }>(`/api/papers/${paperId}/search?page=${page}&q=${encodeURIComponent(highlight.slice(0, 200))}`, true).then((r) => setRects(r.rects)).catch(() => setRects([]))
  }, [paperId, page, highlight])
  useEffect(() => {
    if (!rects.length || !loaded || !boxRef.current) return
    const scale = imgW / pageWidth
    boxRef.current.scrollTo({ top: Math.max(0, rects[0][1] * scale - 120), behavior: 'smooth' })
  }, [rects, loaded, imgW, pageWidth])
  const scale = imgW && pageWidth ? imgW / pageWidth : 1
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-2 py-1 text-xs dark:border-white/10 dark:bg-[#1b1e23]">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
        <span className="num">Page {page} / {pageCount}</span>
        <Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => onPage(page + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
        <span className="mx-1 h-4 w-px bg-neutral-300 dark:bg-white/10" />
        <Button size="sm" variant="ghost" onClick={() => setZoom(Math.max(0.6, zoom - 0.2))}><ZoomOut className="h-3.5 w-3.5" /></Button>
        <span className="num w-10 text-center">{Math.round(zoom * 100 / 1.4)}%</span>
        <Button size="sm" variant="ghost" onClick={() => setZoom(Math.min(3, zoom + 0.2))}><ZoomIn className="h-3.5 w-3.5" /></Button>
        {highlight && <span className={rects.length ? 'ml-2 text-cyan-700 dark:text-cyan-300' : 'ml-2 text-amber-600'}>{rects.length ? `source passage located (${rects.length} match${rects.length > 1 ? 'es' : ''})` : 'passage not found verbatim on this page'}</span>}
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-auto bg-neutral-300 p-3 dark:bg-neutral-800">
        <div className="relative mx-auto w-fit shadow-lg">
          <img ref={imgRef} alt={`Page ${page}`} src={api.url(`/api/papers/${paperId}/page/${page}.png?zoom=${zoom.toFixed(2)}`)}
            onLoad={(e) => { setLoaded(true); setImgW((e.target as HTMLImageElement).naturalWidth) }} style={{ width: imgW || undefined }} className="block max-w-none bg-white" />
          {rects.map((r, i) => (
            <div key={i} className="pointer-events-none absolute rounded-sm border-2 border-cyan-500 bg-cyan-400/25"
              style={{ left: r[0] * scale - 2, top: r[1] * scale - 2, width: (r[2] - r[0]) * scale + 4, height: (r[3] - r[1]) * scale + 4 }} />
          ))}
        </div>
      </div>
    </div>
  )
}
