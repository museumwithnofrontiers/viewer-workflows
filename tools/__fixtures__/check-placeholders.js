// Refuses to let a half-configured copy of the template install.
//
// npm resolves the dependency tree *before* it runs `preinstall`, so this
// script is not what stops a wholly unconfigured template: there, npm fails
// first with a 404 on `@museumwnf/__DATASET__-data`. The cases divide up like
// this, and between them nothing gets through:
//
//   - dataset name still `__DATASET__`   -> npm's own 404, before this runs
//   - version still `0.0.0-REPLACE-ME`   -> npm's own "no matching version"
//   - name replaced in package.json but
//     missed in index.html or in
//     src/dataset.config.js              -> only this script catches it
//   - __SITE_CLASS__ / __SITE_NAMESPACE__
//     left as they are                   -> only this script catches it
//
// The last two are the cases worth having a guard for. Those files are invisible
// to npm, so the install succeeds, the build succeeds, and the site deploys with
// `__DATASET__` sitting in its <title> and in its header — or, for the text
// placeholders, importing a bundle that does not exist and naming its own
// entries after a word that is not a name.
//
// The files are listed rather than swept for the placeholder because README
// step 2 and the comment in .github/workflows/ci.yml both name it on purpose;
// a tree-wide search would reject the template for documenting itself. The
// list is the one README step 2 hands the admin, so the two move together.
import { readFileSync } from 'node:fs'

const NAME_PLACEHOLDER = '__DATASET__'

// No package publishes a `0.0.0-REPLACE-ME`, which is the point: replacing the
// dataset *name* alone used to leave a plausible `^1.0.0` behind that resolved
// for a dataset still on 1.x and failed only for one that had reached 2.x. A
// version that can never resolve turns that silent, dataset-dependent trap
// into the same failure every time.
const VERSION_PLACEHOLDER = '0.0.0-REPLACE-ME'

const CONFIGURED_FILES = [
  'package.json',
  'vite.config.js',
  'src/dataset.config.js',
  'src/main.js',
  'src/SiteShell.vue',
  'index.html',
  'locales/en.json',
  'tests/smoke.test.js',
]

// Which shared texts this website receives, and the name its own entries carry.
// npm cannot notice either: the class is part of an import specifier and the
// namespace is part of an entry name, so both survive a successful install and
// a successful build, and fail only where a reader sees them.
const TEXT_PLACEHOLDERS = {
  __SITE_CLASS__: 'the kind of website: standalone, gallery or exhibition',
  __SITE_NAMESPACE__:
    'the name this website’s own entries carry, one lowercase word ' +
    '(e.g. carpets, waterInIslam)',
}

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

if (unreplaced.length === 0 && !hasPlaceholderVersion && unreplacedText.length === 0) {
  process.exit(0)
}

const lines = ['', 'This repository is still the unconfigured website template.', '']

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
  '  See README.md, "Admin — creating a new website", steps 2, 3 and 4.',
  '',
)

console.error(lines.join('\n'))
process.exit(1)
