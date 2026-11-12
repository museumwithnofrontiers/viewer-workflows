// The galleries, exhibitions, Sharing History, Explore and the galleries hub
// adopt viewer-core 2.21.0's main.js helpers and drop what only templates need;
// a gallery's chip table goes where viewer-layout 3.71.0's projectChips()
// derives the same chips (shared-code review R4, R6, R7). islamicart and
// baroqueart make the same changes in their own pull requests, with R8.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dropTemplateLeftovers, mainWithHelpers, read, write } from './_shared.mjs'

export const branch = 'chore/sweep-site-helpers'
export const title = "Adopt viewer-core's main.js helpers and the derived chips"
export const body = `
main.js loads this site's own texts with viewer-core's \`textsByLanguage\`
instead of a hand-written loop. The template's placeholder guard, the empty
.npmrc and the ~/.npmrc mount are gone. A gallery's source chips now come from
its package (viewer-layout's \`projectChips\`, from each project's site), so its
projectColors table goes; the chips drawn stay the same.
`
export const families = ['gallery-template', 'exhibition-template', 'website-template']

const BY_HAND = new Set(['islamicart', 'baroqueart'])

export const VERSIONS = ['@museumwnf/viewer-core@^2.21.0', '@museumwnf/viewer-layout@^3.71.0']

// viewer-layout's projectChips(), repeated for the check below: the sweep
// runs in plain Node, where the built package (it carries .vue files) cannot
// be imported.
const PRODUCT_CHIPS = {
  islamicart: 'mwnf-chip--ISLandEPM', baroqueart: 'mwnf-chip--DBA', sharinghistory: 'mwnf-chip--AWE',
  carpets: 'mwnf-chip--DCA', glass: 'mwnf-chip--DGA',
}
const EXHIBITIONS = new Set(['arts-in-dialogue', 'the-hijaz-railway', 'the-table-is-set', 'the-use-of-colours-in-art', 'water-in-islam', 'with-brush-and-qalam'])
export function chips(manifest) {
  const out = {}
  for (const [id, project] of Object.entries(manifest?.projects ?? {})) {
    if (!project || !('home_site' in project)) continue
    const site = project.home_site
    const chip = site === null ? 'mwnf-chip--Galleries' : PRODUCT_CHIPS[site] ?? (EXHIBITIONS.has(site) ? 'mwnf-chip--EXH' : null)
    if (chip) out[id] = chip
  }
  return out
}

// The table every gallery's dataset.config.js declared, and its use in the call.
const TABLE = /\n\/\/ The source-database chip's colour, per project: one of\n\/\/ @museumwnf\/viewer-layout's `mwnf-chip--<name>` classes for every project id\n\/\/ the package's `manifest.projects` carries\.\nexport const projectColors = \{\n([\s\S]*?)\n\}\n/
// The Hijaz Railway's chip on communication: the Galleries colour by default
// there, the exhibitions' everywhere else; Pascal chose the exhibitions' (2026-11-12).
const APPROVED = { communication: { 'e08d1c71-8cff-5fe9-b480-2ae6c530b732': 'mwnf-chip--Galleries' } }

function withoutChipTable(dir, name, text) {
  const match = text.match(TABLE)
  if (!match) return { text }
  const pkgName = JSON.parse(read(dir, 'package.json')).dependencies
  const dataset = Object.keys(pkgName).find((dep) => /^@museumwnf\/.+-data$/.test(dep))
  const manifestPath = join(dir, 'node_modules', dataset, 'manifest.json')
  if (!existsSync(manifestPath)) return { reason: `${dataset} is not installed` }
  const derived = chips(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const table = Object.fromEntries([...match[1].matchAll(/'([0-9a-f-]{36})': '(mwnf-chip--[A-Za-z]+)'/g)].map((m) => [m[1], m[2]]))
  for (const [id, chip] of Object.entries(table)) {
    if (derived[id] !== chip && APPROVED[name]?.[id] !== chip) return { reason: `chip ${id}: table ${chip}, derived ${derived[id] ?? 'none'}` }
  }
  for (const id of Object.keys(derived)) if (!(id in table)) return { reason: `chip ${id}: derived ${derived[id]}, not in the table` }
  const call = text.replace(TABLE, '\n').replace(/\n  projectColors,\n/, '\n')
  if (/projectColors/.test(call)) return { reason: 'projectColors is still read elsewhere in dataset.config.js' }
  return { text: call }
}

export async function apply({ dir, name, template, install }) {
  if (BY_HAND.has(name)) return 'its own pull request (R8)'
  const main = mainWithHelpers(read(dir, 'src/main.js'))
  if (!main) return "main.js is not the template's"

  await install(...VERSIONS)

  if (template === 'gallery-template') {
    const config = read(dir, 'src/dataset.config.js')
    const { text, reason } = withoutChipTable(dir, name, config)
    if (reason) return reason
    if (text !== config) write(dir, 'src/dataset.config.js', text)
  }
  write(dir, 'src/main.js', main)
  dropTemplateLeftovers(dir)
}
