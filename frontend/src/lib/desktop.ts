/**
 * Desktop (Tauri 2) integrations: native file dialogs, file system access and
 * native menu events. Only imported dynamically when running inside Tauri.
 */
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile as fsRead, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { emitCommand } from '../workspace/commands'

const EXT: Record<string, { name: string; extensions: string[] }> = {
  '.synthea': { name: 'Synthea project', extensions: ['synthea', 'json'] },
  '.json': { name: 'JSON', extensions: ['json'] },
  '.csv': { name: 'CSV', extensions: ['csv'] },
  '.pdf': { name: 'PDF document', extensions: ['pdf'] },
  '.stl': { name: 'STL geometry', extensions: ['stl'] },
  '.txt': { name: 'Text', extensions: ['txt'] },
}

function filtersFor(accept: string) {
  const out = accept.split(',').map((a) => a.trim()).filter(Boolean).map((a) => EXT[a] ?? { name: a.replace('.', '').toUpperCase(), extensions: [a.replace('.', '')] })
  return out.length ? out : undefined
}

export async function openFile(accept: string): Promise<File> {
  const path = await open({ multiple: false, directory: false, filters: filtersFor(accept) })
  if (!path || Array.isArray(path)) throw new Error('No file selected')
  const bytes = await fsRead(path)
  const name = path.split(/[\\/]/).pop() ?? 'file'
  const f = new File([bytes], name)
  Object.defineProperty(f, 'path', { value: path })
  return f
}

export async function savePath(defaultName: string): Promise<string | null> {
  const ext = '.' + (defaultName.split('.').pop() ?? '')
  return save({ defaultPath: defaultName, filters: filtersFor(ext) })
}

export async function writeTo(path: string, data: Blob | string) {
  if (typeof data === 'string') await writeTextFile(path, data)
  else await writeFile(path, new Uint8Array(await data.arrayBuffer()))
}

export async function saveFile(defaultName: string, data: Blob | string): Promise<string | null> {
  const path = await savePath(defaultName)
  if (!path) return null
  await writeTo(path, data)
  return path
}

/** Forward native menu events (emitted by the Rust shell as "menu") to the command bus. */
export async function bindNativeMenu() {
  await listen<string>('menu', (e) => emitCommand(e.payload))
}
