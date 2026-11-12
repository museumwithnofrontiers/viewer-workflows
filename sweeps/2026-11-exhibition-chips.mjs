// The six DXA exhibitions drop their hand-kept chip tables, as the galleries
// did in 2026-11-site-helpers: their packages now name each project's home
// site (inventory-app#2510), from which viewer-layout's projectChips()
// derives the same chips, and describeExhibitionSmoke checks the chips the
// site draws (viewer-layout 3.72.1).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chips } from './2026-11-site-helpers.mjs'
import { read, write } from './_shared.mjs'

export const branch = 'chore/sweep-exhibition-chips'
export const title = 'Derive the source chips from the package'
export const body = `
This exhibition's package now names each project's home site
(inventory-app#2510), so viewer-layout's \`projectChips\` derives the source
chips and the projectColors table goes, as it did on the galleries. The
smoke test checks the chips the site draws (viewer-layout 3.72.1). The chips
drawn stay the same.
`

// The first version of each package that carries home_site.
const DATASETS = {
  'arts-in-dialogue': '1.0.23',
  'the-hijaz-railway': '1.0.25',
  'the-table-is-set': '1.0.22',
  'the-use-of-colours-in-art': '1.0.35',
  'water-in-islam': '1.0.35',
  'with-brush-and-qalam': '1.0.21',
}

// The table every exhibition's dataset.config.js declared.
const TABLE = /\n\/\/ The source-database chip's colour, per project: one of\n\/\/ @museumwnf\/viewer-layout's `mwnf-chip--<name>` classes for every project id\n\/\/ the package's `manifest.projects` carries\.\n\/\/ A record with no project at all is an Explore record, whose chip the\n\/\/ family draws itself\.\nexport const projectColors = \{\n([\s\S]*?)\n\}\n/
const IMPORT = "import config, { noticeProjects, projectColors } from '../src/dataset.config.js'"

export async function apply({ dir, name, install }) {
  const version = DATASETS[name]
  if (!version) return 'not one of the six exhibitions'
  const config = read(dir, 'src/dataset.config.js')
  const smoke = read(dir, 'tests/smoke.test.js')
  const match = config.match(TABLE)
  if (!match || !config.includes('exhibitionConfig(')) return "dataset.config.js is not the exhibition's shape"
  if (!smoke.includes(IMPORT) || !/\n  projectColors,\n/.test(smoke)) return "smoke.test.js is not the exhibition's shape"

  const dataset = `@museumwnf/${name}-data`
  await install(`${dataset}@^${version}`, '@museumwnf/viewer-layout@^3.72.1')
  const manifestPath = join(dir, 'node_modules', dataset, 'manifest.json')
  if (!existsSync(manifestPath)) return `${dataset} is not installed`
  const derived = chips(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const table = Object.fromEntries([...match[1].matchAll(/'([0-9a-f-]{36})': '(mwnf-chip--[A-Za-z]+)'/g)].map((m) => [m[1], m[2]]))
  for (const [id, chip] of Object.entries(table)) {
    if (derived[id] !== chip) return `chip ${id}: table ${chip}, derived ${derived[id] ?? 'none'}`
  }
  for (const id of Object.keys(derived)) if (!(id in table)) return `chip ${id}: derived ${derived[id]}, not in the table`

  const text = config.replace(TABLE, '\n').replace(/\n  projectColors,\n/, '\n')
  if (/projectColors/.test(text)) return 'projectColors is still read elsewhere in dataset.config.js'
  write(dir, 'src/dataset.config.js', text)
  write(dir, 'tests/smoke.test.js', smoke
    .replace(IMPORT, "import config, { noticeProjects } from '../src/dataset.config.js'")
    .replace(/\n  projectColors,\n/, '\n'))
}
