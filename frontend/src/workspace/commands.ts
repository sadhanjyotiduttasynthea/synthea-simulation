import { useEffect, useRef } from 'react'

/**
 * Minimal command bus used by the ribbon, native desktop menus and keyboard
 * shortcuts. Pages subscribe to the commands they implement. A command emitted
 * before its handler is mounted (e.g. "geometry.add.cuboid" from another page)
 * is queued and delivered when a handler subscribes.
 */
type Handler = (payload?: unknown) => void
const handlers = new Map<string, Set<Handler>>()
const pending = new Map<string, unknown[]>()

export function emitCommand(id: string, payload?: unknown): boolean {
  const hs = handlers.get(id)
  if (hs && hs.size) {
    hs.forEach((h) => h(payload))
    return true
  }
  const q = pending.get(id) ?? []
  q.push(payload)
  pending.set(id, q)
  // drop stale queued commands after a short time
  setTimeout(() => {
    const cur = pending.get(id)
    if (cur) {
      const i = cur.indexOf(payload)
      if (i >= 0) cur.splice(i, 1)
    }
  }, 4000)
  return false
}

export function hasHandler(id: string) {
  return (handlers.get(id)?.size ?? 0) > 0
}

export function useCommand(id: string, handler: Handler) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const h: Handler = (p) => ref.current(p)
    if (!handlers.has(id)) handlers.set(id, new Set())
    handlers.get(id)!.add(h)
    const q = pending.get(id)
    if (q && q.length) {
      pending.delete(id)
      setTimeout(() => q.forEach((p) => h(p)), 0)
    }
    return () => {
      handlers.get(id)?.delete(h)
    }
  }, [id])
}
