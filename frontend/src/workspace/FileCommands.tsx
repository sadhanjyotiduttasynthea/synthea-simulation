import { useState } from 'react'
import { Button, Field, Input, Modal } from '../components/ui'
import { api, download, isDesktop, pickFile } from '../lib/api'
import type { Project } from '../lib/types'
import { useStore } from '../store'
import { useCommand } from './commands'
import { refreshTree } from './ModelTree'
import { log, useWs } from './wsStore'

/** Project file handling: New / Open / Save / Save As / recent files (native dialogs on desktop). */
export function FileCommands() {
  const { project, refreshProjects, selectProject, toast } = useStore()
  const addRecent = useWs((s) => s.addRecent)
  const [newOpen, setNewOpen] = useState(false)
  const [name, setName] = useState('')
  const paths = () => JSON.parse(localStorage.getItem('synthea-project-paths') ?? '{}') as Record<string, string>

  const bundle = async () => {
    if (!project) throw new Error('No project open')
    return api.get<unknown>(`/api/projects/${project.id}/export`)
  }

  const saveAs = async () => {
    try {
      const data = JSON.stringify(await bundle(), null, 2)
      const fname = `${project!.name.replace(/[^\w-]+/g, '_')}.synthea`
      const path = await download(fname, data)
      if (path) {
        localStorage.setItem('synthea-project-paths', JSON.stringify({ ...paths(), [project!.id]: path }))
        addRecent(project!.name, path)
        log('success', 'file', `Project saved to ${path}`)
        toast(`Saved ${path}`, 'success')
      }
    } catch (e) {
      log('error', 'file', (e as Error).message)
      toast((e as Error).message, 'error')
    }
  }

  const save = async () => {
    const p = project && paths()[project.id]
    if (isDesktop() && p) {
      try {
        const { writeTo } = await import('../lib/desktop')
        await writeTo(p, JSON.stringify(await bundle(), null, 2))
        log('success', 'file', `Project saved to ${p}`)
        toast('Project saved', 'success')
      } catch (e) {
        toast((e as Error).message, 'error')
      }
    } else if (!isDesktop()) {
      // browser: the project is persisted in the local database continuously; offer a file copy
      log('info', 'file', 'Project data is stored in the local database automatically. Writing a portable .synthea copy.')
      await saveAs()
    } else await saveAs()
  }

  const openProject = async () => {
    try {
      const f = await pickFile('.synthea,.json')
      const b = JSON.parse(await f.text())
      const p = await api.post<Project>('/api/projects/import', b)
      await refreshProjects()
      await selectProject(p.id)
      const path = (f as File & { path?: string }).path ?? f.name
      localStorage.setItem('synthea-project-paths', JSON.stringify({ ...paths(), [p.id]: path }))
      addRecent(p.name, path)
      refreshTree()
      log('success', 'file', `Opened ${path}`)
      toast(`Opened ${p.name}`, 'success')
    } catch (e) {
      if ((e as Error).message !== 'No file selected') toast(`Open failed: ${(e as Error).message}`, 'error')
    }
  }

  useCommand('file.save', save)
  useCommand('file.saveAs', saveAs)
  useCommand('file.open', openProject)
  useCommand('file.new', () => setNewOpen(true))

  const create = async () => {
    const p = await api.post<Project>('/api/projects', { name: name || 'Untitled project' })
    await refreshProjects()
    await selectProject(p.id)
    setNewOpen(false)
    setName('')
    refreshTree()
    log('info', 'file', `Created project ${p.name}`)
  }

  return (
    <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New project" footer={<><Button onClick={() => setNewOpen(false)}>Cancel</Button><Button variant="primary" onClick={create}>Create</Button></>}>
      <Field label="Project name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} /></Field>
      <p className="mt-2 text-[11px] text-neutral-500">Global scientific libraries are shared by all projects; projects reference library records.</p>
    </Modal>
  )
}
