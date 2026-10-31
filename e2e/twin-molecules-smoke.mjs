// Smoke test for the digital twin and molecular-structure pages (needs the running app and Playwright).
// Usage: node e2e/twin-molecules-smoke.mjs   (SYNTHEA_URL defaults to http://localhost:5173)
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = process.env.SYNTHEA_URL ?? 'http://localhost:5173'
const api = async (path, body) => {
  const r = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json()
}
const checks = []
const check = (name, ok, info = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`) }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
try {
  const projects = await api('/api/projects')
  let twins = await api('/api/twins')
  if (!twins.length) { await api('/api/twins/demo', { project_id: projects[0].id }); twins = await api('/api/twins') }
  const heat = twins.find((t) => t.physics.some((p) => p.kind === 'heat')) ?? twins[0]
  await page.goto(`${BASE}/twin?twin=${heat.id}&tab=study`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Compute \(F5\)/ }).first().click()
  await page.waitForURL(/tab=results/, { timeout: 120000 })
  await page.waitForTimeout(1500)
  check('twin study runs from the UI and opens results', /tab=results/.test(page.url()))
  check('results show a colour legend', await page.getByText('Temperature [°C]').count() > 0)
  await page.goto(`${BASE}/twin?twin=${heat.id}&tab=material`, { waitUntil: 'networkidle' })
  check('material inputs link to their source paper', await page.locator('a[href^="/papers?paper="]').count() > 0)

  const mol = await api('/api/molecules', { smiles: 'OCC(O)CO', name: 'Glycerol (smoke test)' })
  await page.goto(`${BASE}/molecules?mol=${mol.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  check('molecule page renders a 3-D canvas', await page.locator('canvas').count() > 0)
  check('computed properties are listed', await page.getByText('Diffusion coefficient in water', { exact: false }).count() > 0)
  await fetch(`${BASE}/api/molecules/${mol.id}`, { method: 'DELETE' })
} catch (e) {
  check('unexpected error', false, e.message)
}
check('no browser errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`)
process.exit(checks.every(Boolean) ? 0 : 1)
