// Helpers the sweeps share: reading and checking a site's files before a
// change rewrites them. A sweep refuses a file that is not the shape it
// expects (returns a reason), so a site that diverged on purpose is left for
// the operator to look at.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const read = (dir, path) => readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n')
export const write = (dir, path, text) => writeFileSync(join(dir, path), text)
export const exists = (dir, path) => existsSync(join(dir, path))
export const remove = (dir, path) => rmSync(join(dir, path), { force: true })

/** A short hash of `text`, for "is this file still the shape every site of the family had". */
export const shape = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** The site's own texts namespace, from package.json's `viewerI18n`. */
export const namespaceOf = (dir) => JSON.parse(read(dir, 'package.json')).viewerI18n?.namespace

const LOCALE_LOOP = `// Every locales/<lang>.json holds this website's own texts, and may overload
// any entry it receives. Local wins — that is the only merge rule there is.
const localeFiles = import.meta.glob('../locales/*.json', { eager: true })
const ownTexts = {}
for (const [path, module] of Object.entries(localeFiles)) {
  const lang = path.split('/').pop().replace(/\\.json$/, '')
  ownTexts[lang] = module.default
}

createStandardViewer(config, undefined, { dictionary: sharedTexts, ownMessages: ownTexts })
`

const OWN_TEXTS = `// Every locales/<lang>.json holds this website's own texts, and may overload
// any entry it receives. Local wins — that is the only merge rule there is.
createStandardViewer(config, {
  dictionary: sharedTexts,
  ownMessages: textsByLanguage(import.meta.glob('../locales/*.json', { eager: true })),
})
`

/**
 * main.js with viewer-core 2.21.0's helpers instead of the hand-written locale
 * loop, or null when main.js does not end with that loop.
 */
export function mainWithHelpers(text) {
  const importLine = "import { createStandardViewer } from '@museumwnf/viewer-core'\n"
  if (!text.startsWith(importLine) || !text.endsWith(LOCALE_LOOP)) return null
  return "import { createStandardViewer, textsByLanguage } from '@museumwnf/viewer-core'\n" +
    text.slice(importLine.length, -LOCALE_LOOP.length) + OWN_TEXTS
}

const NPMRC_MOUNT = `      # Every @museumwnf package installs anonymously from npmjs (public,
      # no login needed) — this mount is only for whatever a site's own
      # .npmrc or ~/.npmrc still adds on top (a not-yet-migrated GitHub
      # Packages scope, a private registry for something else). Leave it
      # mounted; it is a no-op once nothing in the tree needs it.
      - \${HOME}/.npmrc:/root/.npmrc:ro
`
const DOCKERFILE_NOTE = `# The repo is bind-mounted at /app and your own ~/.npmrc read-only at
# /root/.npmrc (see compose.yml). Installing at start-up keeps the container in
# sync with the mounted lockfile; the @museumwnf packages resolve anonymously
# from npmjs (public, no login). Nothing in this repository holds a token.
`
const DOCKERFILE_NOTE_AFTER = `# The repo is bind-mounted at /app (see compose.yml). Installing at start-up
# keeps the container in sync with the mounted lockfile; the @museumwnf
# packages resolve anonymously from npmjs (public, no login). Nothing in this
# repository holds a token.
`

/**
 * What a created site no longer needs from its template (R7): the placeholder
 * guard and its `preinstall`, the `.npmrc` that only held a comment, and the
 * `~/.npmrc` mount compose.yml says is a no-op. Each file is touched only when
 * it is still the template's.
 */
export function dropTemplateLeftovers(dir) {
  const pkg = JSON.parse(read(dir, 'package.json'))
  if (pkg.scripts?.preinstall === 'node scripts/check-placeholders.js') {
    delete pkg.scripts.preinstall
    write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`)
    remove(dir, 'scripts/check-placeholders.js')
  }
  if (exists(dir, '.npmrc') && read(dir, '.npmrc').split('\n').every((line) => line.startsWith('#') || !line.trim())) {
    remove(dir, '.npmrc')
  }
  if (exists(dir, 'compose.yml')) {
    const compose = read(dir, 'compose.yml')
    if (compose.includes(NPMRC_MOUNT)) write(dir, 'compose.yml', compose.replace(NPMRC_MOUNT, ''))
  }
  if (exists(dir, 'Dockerfile')) {
    const docker = read(dir, 'Dockerfile')
    if (docker.includes(DOCKERFILE_NOTE)) write(dir, 'Dockerfile', docker.replace(DOCKERFILE_NOTE, DOCKERFILE_NOTE_AFTER))
  }
}
