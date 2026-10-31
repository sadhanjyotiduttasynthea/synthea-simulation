// End-to-end check of the 14-step hackathon demonstration.
// Usage: start backend (port 8000) and frontend dev server (port 5173), then
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
function check(step, ok, detail = '') {
  current = `after ${step}`
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true })
const page = await ctx.newPage()
let current = 'start'
page.on('pageerror', (e) => errors.push(`[${current}] ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`[${current}] ${m.text().slice(0, 200)}`))
const go = async (path, wait = 1200) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); await page.waitForTimeout(wait) }
const shot = async (name) => shotDir && page.screenshot({ path: `${shotDir}/${name}.png` })
const text = async () => (await page.locator('main').innerText()).toLowerCase()

try {
  // reset demo for reproducibility
  await page.request.post(BASE + '/api/admin/reset-demo')
  await page.evaluate(() => localStorage.clear()).catch(() => {})

  // 1. open project
  await go('/')
  check('1. Open project', (await text()).includes('Affordable Pea Protein Snack'.toLowerCase()))
  await shot('01-dashboard')

  // 2. inspect six ingredients
  await go('/materials')
  const rows = await page.locator('main tbody tr').count()
  check('2. Inspect six ingredients', rows >= 6, `${rows} rows`)
  await shot('02-materials')

  // 3-4. edit baseline, results update
  await go('/formulation')
  const resultsPanel = () => page.locator('section', { hasText: 'Cost / serving' }).first().innerText()
  const before = await resultsPanel()
  const pea = page.locator('input[type=number]').first()
  await pea.fill('25')
  await pea.press('Enter')
  await page.waitForTimeout(1200)
  const after = await resultsPanel()
  const sumOk = (await text()).includes('Σ 100.000 %'.toLowerCase())
  check('3. Edit baseline formulation', sumOk, 'total kept at 100 %')
  check('4. Nutrition and cost update immediately', before !== after, after.replace(/\s+/g, ' ').slice(0, 60))
  await shot('03-formulation')

  // 5-8. optimiser with protein >= 15 %, cost <= 2.20
  await go('/optimizer')
  const minP = page.locator('label:has-text("Min protein") input')
  const maxC = page.locator('label:has-text("Max cost") input')
  await minP.fill('15'); await minP.press('Enter')
  await maxC.fill('2.2'); await maxC.press('Enter')
  check('5. Set minimum protein 15 %', (await minP.inputValue()) === '15')
  check('6. Set maximum cost €2.20/kg', (await maxC.inputValue()) === '2.2')
  await page.getByRole('button', { name: 'Run optimiser' }).click()
  await page.waitForTimeout(3000)
  const t = await text()
  check('7. Run real optimiser', t.includes('Lowest cost'.toLowerCase()) && t.includes('Highest protein'.toLowerCase()))
  check('8. Compare three candidates', ['Lowest cost', 'Balanced (Pareto)', 'Highest protein'].every((s) => t.includes(s.toLowerCase())) && t.includes('Pareto front'.toLowerCase()))
  await shot('05-optimizer')

  // infeasible variant
  await minP.fill('60'); await minP.press('Enter')
  await page.getByRole('button', { name: 'Run optimiser' }).click()
  await page.waitForTimeout(2500)
  check('8b. Infeasible constraints are explained', (await text()).includes('Infeasible problem'.toLowerCase()))
  await minP.fill('15'); await minP.press('Enter')
  await page.getByRole('button', { name: 'Run optimiser' }).click()
  await page.waitForTimeout(2500)

  // 9. experimental savings scenario
  await go('/experiments')
  await page.getByRole('button', { name: /Cost-reduction/ }).click()
  await page.waitForTimeout(1200)
  const conv = page.locator('label:has-text("Conventional experiments") input')
  await conv.fill('250'); await conv.press('Enter')
  await page.waitForTimeout(1000)
  check('9. Editable experimental savings scenario', (await text()).includes('€42,500'.toLowerCase()), 'conventional cost recalculated for 250 experiments')
  await shot('09-cost')

  // 10-11. transfer to process simulator and run
  await go('/optimizer')
  await page.getByRole('button', { name: 'To process' }).click()
  await page.waitForTimeout(2000)
  check('10. Transfer formulation to process simulator', page.url().endsWith('/process') && (await page.locator('select').nth(1).innerText()).length > 0)
  await page.getByRole('button', { name: 'Run simulation' }).click()
  await page.waitForTimeout(2000)
  check('11. Run supported process calculations', (await text()).includes('Specific energy'.toLowerCase()) && (await text()).includes('kWh/kg'.toLowerCase()))
  await shot('11-process')

  // 12-13. transfer to printing and animate
  await go('/optimizer')
  await page.getByRole('button', { name: 'To 3D print' }).click()
  await page.waitForTimeout(5000)
  check('12. Transfer formulation to 3D printing', page.url().endsWith('/printing') && (await text()).includes('Toolpath length'.toLowerCase()))
  const prog1 = await page.locator('input[aria-label="Print progress"]').inputValue()
  await page.waitForTimeout(1500)
  const prog2 = await page.locator('input[aria-label="Print progress"]').inputValue()
  check('13. Animate generated toolpath', Number(prog2) > Number(prog1), `progress ${prog1} → ${prog2}`)
  await shot('13-printing')

  // 14. export report
  await go('/reports')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Generate PDF report' }).click()])
  const pdfPath = (shotDir ?? '/tmp') + '/synthea_report.pdf'
  await dl.saveAs(pdfPath)
  const head = fs.readFileSync(pdfPath).subarray(0, 4).toString()
  check('14. Export a report', head === '%PDF', pdfPath)

  // assistant
  await page.getByRole('button', { name: 'Assistant' }).click()
  await page.getByRole('button', { name: 'Explain these results' }).click()
  await page.waitForTimeout(1500)
  check('Assistant answers without external API', (await page.locator('aside').last().innerText()).includes('computation engine'))
} catch (e) {
  check('Unexpected error', false, e.message)
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed; browser errors: ${errors.length}`)
if (errors.length) console.log(errors.slice(0, 5).join('\n'))
process.exit(failed.length || errors.length ? 1 : 0)
