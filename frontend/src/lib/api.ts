import { log } from '../workspace/wsStore'

/**
 * API client. In the browser the backend is reached through the Vite proxy (/api).
 * In the desktop app the Tauri shell starts a local backend sidecar bound to
 * 127.0.0.1 on a free port and provides the URL plus a per-session token.
 */
const cfg: { base: string; token: string | null } = { base: (import.meta.env.VITE_API_BASE as string | undefined) ?? '', token: null }

export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function initApi(): Promise<void> {
  if (!isDesktop()) return
  const { invoke } = await import('@tauri-apps/api/core')
  for (let i = 0; i < 120; i++) {
    try {
      const info = await invoke<{ url: string; token: string; ready: boolean }>('backend_info')
      cfg.base = info.url
      cfg.token = info.token
      if (info.ready) {
        const r = await fetch(`${cfg.base}/api/health`, { headers: { 'X-Synthea-Token': cfg.token } }).catch(() => null)
        if (r?.ok) return
      }
    } catch { /* backend not yet registered */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('The local compute engine did not start. See the application log for details.')
}

export const apiBase = () => cfg.base
const headers = (json: boolean): Record<string, string> => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...(cfg.token ? { 'X-Synthea-Token': cfg.token } : {}) })

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown, quiet = false): Promise<T> {
  let res: Response
  try {
    res = await fetch(cfg.base + path, { method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch {
    const msg = 'Cannot reach the Synthea compute engine. Is the backend running?'
    if (!quiet) log('error', 'api', `${method} ${path}: ${msg}`)
    throw new ApiError(0, msg)
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j?.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch { /* ignore */ }
    if (!quiet) log(res.status >= 500 ? 'error' : 'warn', 'api', `${method} ${path}: ${msg}`)
    throw new ApiError(res.status, msg)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return res.json() as Promise<T>
  return (await res.text()) as unknown as T
}

export const api = {
  get: <T>(p: string, quiet = false) => request<T>('GET', p, undefined, quiet),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  url: (p: string) => cfg.base + p + (cfg.token ? `${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(cfg.token)}` : ''),
  async blob(path: string, body: unknown): Promise<Blob> {
    const res = await fetch(cfg.base + path, { method: 'POST', headers: headers(true), body: JSON.stringify(body) })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res.blob()
  },
  async upload<T>(path: string, file: Blob, filename: string, fields: Record<string, string> = {}): Promise<T> {
    const fd = new FormData()
    fd.append('file', file, filename)
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v))
    const res = await fetch(cfg.base + path, { method: 'POST', headers: cfg.token ? { 'X-Synthea-Token': cfg.token } : undefined, body: fd })
    if (!res.ok) {
      let msg = `${res.status}`
      try { msg = (await res.json()).detail ?? msg } catch { /* ignore */ }
      log('warn', 'api', `upload ${path}: ${msg}`)
      throw new ApiError(res.status, msg)
    }
    return res.json()
  },
}

/** Save data to a file: native "Save as" dialog on desktop, browser download otherwise. */
export async function download(filename: string, data: Blob | string, type = 'application/json'): Promise<string | null> {
  if (isDesktop()) {
    const { saveFile } = await import('./desktop')
    return saveFile(filename, data)
  }
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return filename
}

/** Read a text file chosen by the user (native dialog on desktop). */
export async function readFile(accept: string): Promise<string> {
  const f = await pickFile(accept)
  return f.text()
}

/** Let the user pick a file; returns a File (desktop: read through the fs plugin). */
export function pickFile(accept: string): Promise<File> {
  if (isDesktop()) return import('./desktop').then((d) => d.openFile(accept))
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return reject(new Error('No file selected'))
      resolve(f)
    }
    input.click()
  })
}
