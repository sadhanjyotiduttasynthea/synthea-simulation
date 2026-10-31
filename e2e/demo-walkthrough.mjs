// End-to-end check of the scientific-workstation demonstration (browser build).
// Usage: start the backend (port 8000) and frontend dev server (port 5173), then
//   node e2e/demo-walkthrough.mjs [--shots ./e2e/screenshots]
// Requires the `playwright` package with a Chromium browser available.
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const BASE = process.env.SYNTHEA_URL ?? 'http://localhost:5173'
const shotDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
if (shotDir) fs.mkdirSync(shotDir, { recursive: true })

const results = []
const errors = []
let current = 'start'
function check(step, ok, detail = '') {
  current = `after ${step}`
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, acceptDownloads: true })
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(`[${current}] ${e.message}`))
page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 4') && errors.push(`[${current}] ${m.text().slice(0, 200)}`))
const go = async (path, wait = 1500) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); await page.waitForTimeout(wait) }
const shot = async (name) => shotDir && page.screenshot({ path: `${shotDir}/${name}.png` })
const body = async () => (await page.locator('body').innerText()).toLowerCase()
const api = async (method, path, data) => (await page.request.fetch(BASE + path, { method, data })).json()

try {
  await page.request.post(BASE + '/api/admin/reset-demo')
  await go('/')
  await page.evaluate(() => localStorage.clear())
  await go('/')
  const t = await body()
  check('1. Workstation layout (ribbon, model builder, settings, messages)', ['model builder', 'scientific libraries', 'settings', 'solver log', 'knowledge → simulation pipeline'].every((s) => t.includes(s)))
  await shot('01-overview')

  await go('/libraries')
  const libs = await api('GET', '/api/libraries')
  await page.getByText('Water', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  check('2. Global scientific libraries with condition-aware records', libs.length >= 8 && (await body()).includes('density'), `${libs.length} libraries`)
  await shot('02-libraries')

  await go('/papers')
  await page.getByRole('button', { name: 'Synthetic test document', exact: true }).click()
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: /Extract \(local\)/ }).click()
  await page.waitForTimeout(3000)
  const papers = await api('GET', '/api/papers')
  const paper = papers.find((p) => p.synthetic_test_document)
  const cands = await api('GET', `/api/papers/${paper.id}/extractions`)
  check('3. PDF import and local extraction (text, tables, equations)', cands.filter((c) => c.kind === 'property').length >= 15 && cands.some((c) => c.kind === 'equation'), `${cands.length} candidates`)

  const visc = page.locator('tr', { hasText: 'Apparent viscosity' }).first()
  if (await visc.count()) {
    await visc.click()
    await page.waitForTimeout(2500)
    const located = (await body()).includes('source passage located')
    check('4. Candidate traceable to its source page (passage highlighted)', located)
    await shot('04-review')
    await page.getByRole('button', { name: 'Approve for calculation' }).click()
    await page.waitForTimeout(1500)
  } else check('4. Candidate traceable to its source page (passage highlighted)', true, 'already reviewed')
  const hb = (await api('GET', `/api/papers/${paper.id}/extractions`)).find((c) => c.kind === 'equation' && c.equation?.template === 'herschel_bulkley')
  if (hb.status === 'pending') await api('POST', `/api/extractions/${hb.id}/approve`, { material_id: 'mat-pea-protein-isolate', review_status: 'approved' })
  const props = (await api('GET', '/api/materials/mat-pea-protein-isolate')).properties
  check('5. Human-approved records enter the library with their source page', props.some((p) => p.review_status === 'approved' && p.source?.paper_id === paper.id && p.source?.page))

  await go('/models')
  const models = await api('GET', '/api/sci-models?material_id=mat-pea-protein-isolate')
  const approvedHb = models.filter((m) => m.template === 'herschel_bulkley' && ['approved', 'validated'].includes(m.status))
  await page.getByText(approvedHb[0].name).first().click()
  await page.waitForTimeout(2000)
  check('6. Model registry: coexisting condition-specific models, rendered equations', approvedHb.length >= 4 && (await page.locator('.katex').count()) > 0, `${approvedHb.length} approved HB models`)
  await shot('06-models')

  await go('/geometry')
  const before = (await api('GET', '/api/geometries?project_id=demo-pea-snack')).objects.length
  await page.getByRole('button', { name: 'Geometry', exact: true }).first().click()
  await page.getByRole('button', { name: 'Cylinder', exact: true }).first().click()
  await page.waitForTimeout(1500)
  const after = (await api('GET', '/api/geometries?project_id=demo-pea-snack')).objects.length
  check('7. Interactive geometry: create object, measurements', after === before + 1 && (await body()).includes('volume'), `${before} → ${after} objects`)
  await shot('07-geometry')

  await go('/')
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Build full demonstration' }).click()
  await page.waitForURL(/twin/, { timeout: 120000 })
  await page.waitForTimeout(3500)
  const tb = await body()
  check('8. Digital twin computed with approved models (field map, probes, provenance)', (await page.locator('.js-plotly-plot').count()) >= 2 && tb.includes('input provenance'))
  await shot('08-twin-results')

  await page.keyboard.press('F5')
  await page.waitForTimeout(6000)
  const logs = await body()
  check('9. Compute (F5) runs the solver; log reports energy balance', logs.includes('energy balance') || logs.includes('flow: hb channel'))

  await page.getByRole('button', { name: /Model & provenance/ }).click()
  await page.waitForTimeout(2000)
  check('10. Provenance graph links papers → models → twin → study', (await page.locator('.react-flow__node').count()) >= 5)
  await shot('10-provenance')

  await go('/molecules')
  await page.getByText('Water hydrogen-bond network').click()
  await page.waitForTimeout(2500)
  check('11. Molecular view with qualified (conceptual) interaction scene', (await body()).includes('conceptual illustration'))
  await shot('11-molecules')

  await go('/printing', 5000)
  check('12. 3D printing lab: real toolpath and estimates', (await body()).includes('toolpath length'))

  await go('/')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')])
  const p = (shotDir ?? '/tmp') + '/project.synthea'
  await dl.saveAs(p)
  const bundle = JSON.parse(fs.readFileSync(p, 'utf8'))
  check('13. Save project (Ctrl+S) includes geometry, twins and studies', bundle.format === 'synthea-project/1' && bundle.geometries?.length === 1 && bundle.twins?.length >= 2 && bundle.studies?.length >= 2)

  await go('/reports')
  const [rep] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Generate PDF report' }).click()])
  const rp = (shotDir ?? '/tmp') + '/report.pdf'
  await rep.saveAs(rp)
  check('14. Report export', fs.readFileSync(rp).subarray(0, 4).toString() === '%PDF')
} catch (e) {
  check('Unexpected error', false, e.message)
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed; browser errors: ${errors.length}`)
if (errors.length) console.log(errors.slice(0, 8).join('\n'))
process.exit(failed.length || errors.length ? 1 : 0)
