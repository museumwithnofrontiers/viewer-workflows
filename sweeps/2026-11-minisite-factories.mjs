// The mini-sites adopt their family's factory and smoke suite (shared-code
// review R1, R2, R6, R7; viewer-layout 3.71.0, viewer-core 2.21.0).
import { dropTemplateLeftovers, mainWithHelpers, namespaceOf, read, remove, shape, write } from './_shared.mjs'

export const branch = 'chore/sweep-minisite-factories'
export const title = "Adopt the family's config factory and smoke suite"
export const body = `
dataset.config.js and tests/smoke.test.js were the same in every mini-site of
the family. They now come from viewer-layout (\`minisiteConfig\` and its siblings,
\`describeMinisiteSmoke\`), so a change to them lands once, in the package.
What is this site's own stays here: minisite.json, the theme, the chrome and
its texts.

Also: main.js uses viewer-core's \`textsByLanguage\`; tests/assets.test.js is
part of the shared suite; the template's placeholder guard, the empty .npmrc
and the ~/.npmrc mount are gone.
`
export const families = ['minisite-template', 'baroqueart-minisite-template', 'sharinghistory-minisite-template']

// What each family's dataset.config.js and smoke test were, the site's slug,
// name and namespace aside: a site whose files differ is left alone.
// Keyed by minisite.json's family, not the template: a site may have been
// created from another family's template before its own existed.
const SHAPES = {
  ISL: { config: '1b61b5edc8cb', smoke: '60c627f0226f' },
  GAI: { config: '1b61b5edc8cb', smoke: '60c627f0226f' },
  BAR: { config: 'f883cde6be56', smoke: 'f3f811946c1f' },
  SH: { config: 'fa97cdae7f59', smoke: 'e9a906c828e8' },
}
const ASSETS_TEST = '902b8b70a0c9'

const FACTORIES = {
  ISL: ['minisiteConfig', "one of Discover Islamic Art's virtual exhibitions"],
  GAI: ['artintroConfig', "Discover Islamic Art's Artistic Introduction"],
  BAR: ['baroqueartMinisiteConfig', "one of Discover Baroque Art's virtual exhibitions"],
  SH: ['sharinghistoryMinisiteConfig', "one of Sharing History's exhibitions"],
}

export const VERSIONS = ['@museumwnf/viewer-core@^2.21.0', '@museumwnf/viewer-layout@^3.71.0']

const quoted = (text) => `'${text.replace(/['\\]/g, '\\$&')}'`

export function config({ factory, what, name, siteName }) {
  return `import { ${factory} } from '@museumwnf/viewer-layout/minisite'
import exhibition from './minisite.json'

// The whole declaration of this website: ${what}, a website of its own. Its
// pages, frame, menu and languages are its family's (\`${factory}\`,
// @museumwnf/viewer-layout/minisite). What is this site's own is minisite.json
// (what legacy configured for it alone), its theme (theme/tokens.css) and its
// legacy pictures (theme/assets/legacy/, SOURCES.json names where each was
// taken from), written by inventory-app's scripts/minisites generators.

// The pictures of the frame, as Vite builds and fingerprints them; the pages
// name a file by its path under theme/assets/.
const chrome = import.meta.glob('../theme/assets/**/*.{jpg,jpeg,png,gif,svg}', {
  eager: true, query: '?url', import: 'default',
})

export default ${factory}({
  // The dataset package this website renders. Must match the alias in
  // vite.config.js and the dependency in package.json.
  datasetPackage: '@museumwnf/${name}-data',

  // The name for a package that predates \`manifest.site\`.
  siteName: ${quoted(siteName)},

  // The GitHub Pages address of this repository, no trailing slash.
  origin: 'https://museumwithnofrontiers.github.io/${name}',

  exhibition,
  chrome,
})
`
}

export function smoke(namespace) {
  return `import { describeMinisiteSmoke } from '@museumwnf/viewer-layout/minisite/testing'
import { catalogues as sharedTexts } from '../src/texts.js'
import ownTexts from '../locales/en.json'
import config from '../src/dataset.config.js'
import exhibition from '../src/minisite.json'
import sources from '../theme/assets/legacy/SOURCES.json'

// The family's smoke test (@museumwnf/viewer-layout/minisite/testing), run
// against this site's own settings, chrome and dataset. Tests of this site's
// own go after the call.
describeMinisiteSmoke({ config, exhibition, sharedTexts, ownTexts, sources, namespace: '${namespace}' })
`
}

export async function apply({ dir, name, install }) {
  const family = JSON.parse(read(dir, 'src/minisite.json')).family ?? 'ISL'
  const [factory, what] = FACTORIES[family] ?? []
  if (!factory || !SHAPES[family]) return `unknown family "${family}" in minisite.json`
  const oldConfig = read(dir, 'src/dataset.config.js')
  const siteName = oldConfig.match(/siteName: manifest\.site\?\.names\?\.en \?\? '([^']*)'/)?.[1]
  const namespace = namespaceOf(dir)
  const normalized = oldConfig.split(name).join('__SLUG__').replace(/siteName: manifest\.site\?\.names\?\.en \?\? '[^']*'/, 'siteName: __NAME__')
  if (!siteName || shape(normalized) !== SHAPES[family].config) return 'dataset.config.js is not the family\'s'
  if (shape(read(dir, 'tests/smoke.test.js').split(`'${namespace}'`).join('__NS__')) !== SHAPES[family].smoke) return 'smoke.test.js is not the family\'s'
  if (shape(read(dir, 'tests/assets.test.js')) !== ASSETS_TEST) return 'assets.test.js is not the family\'s'
  const main = mainWithHelpers(read(dir, 'src/main.js'))
  if (!main) return 'main.js is not the template\'s'

  write(dir, 'src/dataset.config.js', config({ factory, what, name, siteName }))
  write(dir, 'tests/smoke.test.js', smoke(namespace))
  remove(dir, 'tests/assets.test.js')
  write(dir, 'src/main.js', main)
  dropTemplateLeftovers(dir)
  await install(...VERSIONS)
}
