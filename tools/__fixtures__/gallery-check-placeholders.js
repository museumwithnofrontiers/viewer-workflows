// Refuses to let a half-configured copy of this template install.
//
// npm resolves the dependency tree *before* it runs `preinstall`, so this
// script is not what stops a wholly unconfigured template: there, npm fails
// first with a 404 on `@museumwnf/__DATASET__-data`. The cases divide up
// like this, and between them nothing gets through:
//
//   - dataset name still `__DATASET__`      -> npm's own 404, before this runs
//   - version still `0.0.0-REPLACE-ME`      -> npm's own "no matching version"
//   - name replaced in package.json but
//     missed in index.html or in
//     src/dataset.config.js                -> only this script catches it
//   - __SITE_NAME__ / __SITE_NAMESPACE__
//     left as they are                     -> only this script catches it
//   - a __PALETTE_…__ colour left in
//     src/styles/site.css                  -> only this script catches it
//     (inventory-app#2046/#2047: a new site never ships another's colours)
//
// The curatorial picks (CHIP_ITEM_ID, PARTNER_ID, TIMELINE_COUNTRY_CODE, and
// the rest — see the "TODO(dataset): curatorial picks" block in
// tests/smoke.test.js) are deliberately NOT guarded here: unlike a name or a
// namespace, they cannot break `npm install` or the build, only make a test
// assert something false — `npm run test` already catches that, loudly, and
// a guard duplicating the same check here would only drift out of sync with
// the test file over time.
//
// The files are listed rather than swept for the placeholder because
// README.md and the comment in .github/workflows/ci.yml both name it on
// purpose; a tree-wide search would reject the template for documenting
// itself.
import { readFileSync } from 'node:fs'

const NAME_PLACEHOLDER = '__DATASET__'

// No package publishes a `0.0.0-REPLACE-ME`, which is the point: replacing
// the dataset *name* alone used to leave a plausible `^1.0.0` behind that
// resolved for a dataset still on 1.x and failed only for one that had
// reached 2.x. A version that can never resolve turns that silent,
// dataset-dependent trap into the same failure every time.
const VERSION_PLACEHOLDER = '0.0.0-REPLACE-ME'

const CONFIGURED_FILES = [
  'package.json',
  'vite.config.js',
  'index.html',
  'src/dataset.config.js',
  'locales/en.json',
  'tests/smoke.test.js',
]

const TEXT_PLACEHOLDERS = {
  __SITE_NAME__: 'this gallery’s human-readable display name (e.g. "Carpets")',
  __SITE_NAMESPACE__:
    'the name this website’s own entries carry, one lowercase word ' +
    '(e.g. carpets, waterInIslam)',
}

// The palette: this website's own colours, which no default could be.
const PALETTE_FILE = 'src/styles/site.css'
const PALETTE_PLACEHOLDER = /__PALETTE_[A-Z_]+__/g

const read = (file) => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    // A missing file is not this script's business to report: npm, vite and
    // the test suite each fail clearly on their own if one is absent.
    return ''
  }
}

const unreplaced = CONFIGURED_FILES.filter((file) =>
  read(file).includes(NAME_PLACEHOLDER),
)
const hasPlaceholderVersion = read('package.json').includes(VERSION_PLACEHOLDER)
const unreplacedText = Object.keys(TEXT_PLACEHOLDERS).filter((placeholder) =>
  CONFIGURED_FILES.some((file) => read(file).includes(placeholder)),
)

const unsetColours = [...new Set(read(PALETTE_FILE).match(PALETTE_PLACEHOLDER) ?? [])]

if (unreplaced.length === 0 && !hasPlaceholderVersion && unreplacedText.length === 0 && unsetColours.length === 0) {
  process.exit(0)
}

const lines = ['', 'This repository is still the unconfigured gallery-template.', '']

if (unreplaced.length > 0) {
  lines.push(`  ${NAME_PLACEHOLDER} is still present in:`)
  for (const file of unreplaced) lines.push(`    - ${file}`)
  lines.push('', '  Replace it with the dataset key (e.g. islamicart) in each file.', '')
}

if (unreplacedText.length > 0) {
  for (const placeholder of unreplacedText) {
    lines.push(`  ${placeholder} is still present. Replace it with`)
    lines.push(`    ${TEXT_PLACEHOLDERS[placeholder]}.`)
  }
  lines.push('')
}

if (unsetColours.length > 0) {
  lines.push(
    `  The palette in ${PALETTE_FILE} is not set: ${unsetColours.join(', ')}.`,
    '  Copy the gallery’s five colours from inventory-app’s',
    '  .legacy-code/dxa-client/src/sites/<code>/_variables.scss (<code> is the',
    '  gallery’s subdomain in .legacy-code/dxa-client/environment/config.sh),',
    '  and `$theme-dark` again as three numbers for __PALETTE_THEME_DARK_RGB__.',
    '',
  )
}

if (hasPlaceholderVersion) {
  lines.push(
    '  The dataset dependency still carries the placeholder version',
    `  ${VERSION_PLACEHOLDER}, which no package publishes.`,
    '',
  )
}

lines.push(
  '  Then install the dataset itself, which writes the real version range and',
  '  the lockfile in one step:',
  '',
  '      npm install @museumwnf/<dataset>-data@latest',
  '',
  '  See README.md, "Admin — creating a new gallery", steps 2 and 3.',
  '',
)

console.error(lines.join('\n'))
process.exit(1)
