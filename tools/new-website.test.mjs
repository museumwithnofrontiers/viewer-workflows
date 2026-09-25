// Tests for tools/new-website.mjs.
//
// Two fixture blocks below (CARPETS_RULESET, CARPETS_PROTECTION,
// CHECK_PLACEHOLDERS_SOURCE) were captured with `gh api` against real,
// currently-live repositories on 2026-09-21 — museumwithnofrontiers/carpets
// (rulesets + classic protection) and museumwithnofrontiers/website-template
// (scripts/check-placeholders.js). museumwithnofrontiers/water-in-islam (an
// exhibition site, the other class) was read the same day and confirmed to
// carry byte-identical settings for every field these fixtures exercise —
// see the story's PR body for that second read. These fixtures are what
// canonicalRuleset()/canonicalProtection() in new-website.mjs are built to
// match: if a live site's settings ever legitimately change, these fixtures
// (and the canonical payloads) need updating together, not just the code.

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  applyReplacements,
  buildReplacements,
  canonicalProtection,
  canonicalRuleset,
  codeScanningNeedsChange,
  ghApi,
  ghApiMethod,
  pagesNeedsChange,
  parseArgs,
  parseConfiguredFiles,
  parseNamePlaceholder,
  paletteReplacements,
  parsePaletteFile,
  parseTextPlaceholders,
  protectionNeedsChange,
  repoExists,
  repoFlagsNeedChange,
  rulesetNeedsChange,
  securityFixesNeedChange,
  stableStringify,
  templateFor,
} from './new-website.mjs'

// ── parseArgs ────────────────────────────────────────────────────────────

test('parseArgs: the full required set for a real scaffold', () => {
  const opts = parseArgs([
    '--slug', 'carpets', '--class', 'gallery', '--namespace', 'carpets', '--title', 'Carpets', '--palette', 'carpets.json',
  ])
  assert.equal(opts.slug, 'carpets')
  assert.equal(opts.class, 'gallery')
  assert.equal(opts.namespace, 'carpets')
  assert.equal(opts.title, 'Carpets')
  assert.equal(opts.palette, 'carpets.json')
  assert.equal(opts.owner, null)
  assert.equal(opts.dryRun, false)
  assert.equal(opts.settingsOnly, false)
  assert.equal(opts.merge, true)
})

test('parseArgs: --slug is required even with --settings-only', () => {
  assert.throws(() => parseArgs(['--settings-only']), /--slug <slug> is required/)
})

test('parseArgs: --class/--namespace/--title are required unless --settings-only', () => {
  assert.throws(() => parseArgs(['--slug', 'carpets']), /--class .* is required/)
  assert.throws(() => parseArgs(['--slug', 'carpets', '--class', 'gallery']), /--namespace <ns> is required/)
  assert.throws(
    () => parseArgs(['--slug', 'carpets', '--class', 'gallery', '--namespace', 'carpets']),
    /--title "<name>" is required/
  )
})

test('parseArgs: --settings-only needs only --slug', () => {
  const opts = parseArgs(['--settings-only', '--slug', 'carpets'])
  assert.equal(opts.settingsOnly, true)
  assert.equal(opts.class, null)
})

test('parseArgs: --dry-run, --no-merge and --owner flags', () => {
  const opts = parseArgs(['--settings-only', '--slug', 'carpets', '--dry-run', '--no-merge', '--owner', 'museumwithnofrontiers'])
  assert.equal(opts.dryRun, true)
  assert.equal(opts.merge, false)
  assert.equal(opts.owner, 'museumwithnofrontiers')
})

test('parseArgs: slug must be kebab-case', () => {
  for (const bad of ['Carpets', 'car_pets', '-carpets', 'carpets-', 'car pets', '']) {
    assert.throws(() => parseArgs(['--settings-only', '--slug', bad]), `"${bad}" should have been rejected`)
  }
  // A real multi-word slug is valid.
  assert.equal(parseArgs(['--settings-only', '--slug', 'the-use-of-colours-in-art']).slug, 'the-use-of-colours-in-art')
})

test('parseArgs: class must be one of gallery/exhibition/standalone', () => {
  assert.throws(
    () => parseArgs(['--slug', 'x', '--class', 'museum', '--namespace', 'x', '--title', 'X']),
    /--class must be one of gallery, exhibition, standalone/
  )
})

test('parseArgs: namespace is one lowercase word, no hyphens — camelCase allowed', () => {
  assert.throws(
    () => parseArgs(['--slug', 'x', '--class', 'standalone', '--namespace', 'water-in-islam', '--title', 'X']),
    /--namespace must be one lowercase word/
  )
  assert.throws(
    () => parseArgs(['--slug', 'x', '--class', 'standalone', '--namespace', 'Carpets', '--title', 'X']),
    /--namespace must be one lowercase word/
  )
  assert.equal(
    parseArgs(['--slug', 'x', '--class', 'standalone', '--namespace', 'waterInIslam', '--title', 'X']).namespace,
    'waterInIslam'
  )
})

test('parseArgs: a gallery or an exhibition needs its --palette; a product takes none', () => {
  for (const cls of ['gallery', 'exhibition']) {
    assert.throws(
      () => parseArgs(['--slug', 'x', '--class', cls, '--namespace', 'x', '--title', 'X']),
      /--palette <file.json> is required/
    )
  }
  assert.equal(parseArgs(['--slug', 'x', '--class', 'standalone', '--namespace', 'x', '--title', 'X']).palette, null)
  assert.throws(
    () => parseArgs(['--slug', 'x', '--class', 'standalone', '--namespace', 'x', '--title', 'X', '--palette', 'p.json']),
    /--palette is for a gallery or an exhibition/
  )
  // --settings-only touches no content, so no palette.
  assert.equal(parseArgs(['--settings-only', '--slug', 'carpets']).palette, null)
})

test('templateFor: each class its own template (decision D5)', () => {
  assert.equal(templateFor('standalone'), 'website-template')
  assert.equal(templateFor('gallery'), 'gallery-template')
  assert.equal(templateFor('exhibition'), 'exhibition-template')
  assert.throws(() => templateFor('museum'), /No template for class/)
})

test('parseArgs: unknown argument throws', () => {
  assert.throws(() => parseArgs(['--settings-only', '--slug', 'carpets', '--bogus']), /Unknown argument: --bogus/)
})

// ── ghApi(): the structural dry-run guard ───────────────────────────────

test('ghApiMethod: defaults to GET with no field flags', () => {
  assert.equal(ghApiMethod(['repos/museumwithnofrontiers/carpets']), 'GET')
})

test('ghApiMethod: -f/-F without an explicit method defaults to POST (gh\'s own behaviour)', () => {
  assert.equal(ghApiMethod(['repos/x/y/pages', '-f', 'build_type=workflow']), 'POST')
  assert.equal(ghApiMethod(['repos/x/y', '-F', 'delete_branch_on_merge=true']), 'POST')
})

test('ghApiMethod: an explicit -X/--method wins over the field-flag default', () => {
  assert.equal(ghApiMethod(['repos/x/y/pages', '-X', 'PUT', '-f', 'build_type=workflow']), 'PUT')
  assert.equal(ghApiMethod(['repos/x/y', '--method', 'patch', '-f', 'a=b']), 'PATCH')
})

test('ghApi: in --dry-run, a non-GET call throws and never reaches the runner', () => {
  let called = false
  const runner = () => { called = true; return '{}' }
  assert.throws(
    () => ghApi(['repos/x/y/pages', '-X', 'POST', '-f', 'build_type=workflow'], { dryRun: true, runner }),
    /Refusing to run a non-GET gh api call in --dry-run mode/
  )
  assert.equal(called, false)
})

test('ghApi: in --dry-run, a plain GET still reaches the runner', () => {
  let called = false
  const runner = (args) => { called = true; return JSON.stringify({ args }) }
  const result = ghApi(['repos/museumwithnofrontiers/carpets'], { dryRun: true, runner })
  assert.equal(called, true)
  assert.deepEqual(JSON.parse(result).args, ['api', 'repos/museumwithnofrontiers/carpets'])
})

test('ghApi: outside --dry-run, a non-GET call reaches the runner normally', () => {
  let called = false
  const runner = () => { called = true; return '{}' }
  ghApi(['repos/x/y/pages', '-X', 'POST', '-f', 'build_type=workflow'], { dryRun: false, runner })
  assert.equal(called, true)
})

// ── Ruleset: canonical payload vs a real, live ruleset ──────────────────

// museumwithnofrontiers/carpets, `gh api repos/museumwithnofrontiers/carpets/rulesets/22112430`, 2026-09-21.
const CARPETS_RULESET = {
  id: 22112430,
  name: 'main-requires-pr',
  target: 'branch',
  source_type: 'Repository',
  source: 'museumwithnofrontiers/carpets',
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        required_reviewers: [],
        require_code_owner_review: false,
        dismissal_restriction: { enabled: false, allowed_actors: [] },
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        require_extra_approval_for_unattributed_changes: true,
        allowed_merge_methods: ['merge', 'squash', 'rebase'],
      },
    },
  ],
  node_id: 'RRS_lACqUmVwb3NpdG9yec5Qke6lzgFRaK4',
  created_at: '2026-09-02T15:12:24.631+02:00',
  updated_at: '2026-09-02T15:12:24.704+02:00',
  bypass_actors: [],
  current_user_can_bypass: 'never',
  _links: {
    self: { href: 'https://api.github.com/repos/museumwithnofrontiers/carpets/rulesets/22112430' },
    html: { href: 'https://github.com/museumwithnofrontiers/carpets/rules/22112430' },
  },
}

test('stableStringify: key order does not matter, array order does', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }))
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})

test('canonicalRuleset: matches carpets\' live ruleset exactly, despite key-order differences', () => {
  assert.equal(rulesetNeedsChange(CARPETS_RULESET, canonicalRuleset()), false)
})

test('rulesetNeedsChange: no existing ruleset needs a change', () => {
  assert.equal(rulesetNeedsChange(null), true)
})

test('rulesetNeedsChange: a real drift (0 required approvals changed to 1) is caught', () => {
  const drifted = JSON.parse(JSON.stringify(CARPETS_RULESET))
  drifted.rules[2].parameters.required_approving_review_count = 1
  assert.equal(rulesetNeedsChange(drifted, canonicalRuleset()), true)
})

test('rulesetNeedsChange: read-only fields (id, node_id, created_at, _links, ...) are ignored', () => {
  const withDifferentReadOnlyFields = { ...CARPETS_RULESET, id: 999, node_id: 'different', created_at: 'different' }
  assert.equal(rulesetNeedsChange(withDifferentReadOnlyFields, canonicalRuleset()), false)
})

// ── Classic branch protection: canonical PUT payload vs a real GET response ─

// museumwithnofrontiers/carpets, `gh api repos/museumwithnofrontiers/carpets/branches/main/protection`, 2026-09-21.
// museumwithnofrontiers/water-in-islam (the exhibition class) read the same way, same day,
// is identical in every field below.
const CARPETS_PROTECTION = {
  url: 'https://api.github.com/repos/museumwithnofrontiers/carpets/branches/main/protection',
  required_status_checks: {
    url: 'https://api.github.com/repos/museumwithnofrontiers/carpets/branches/main/protection/required_status_checks',
    strict: false,
    contexts: ['ci / Build (blocking)', 'ci / Test (blocking)', 'locales / Validate locale files', 'ci / Texts (blocking)'],
    contexts_url: 'https://api.github.com/repos/museumwithnofrontiers/carpets/branches/main/protection/required_status_checks/contexts',
    checks: [
      { context: 'ci / Build (blocking)', app_id: 15368 },
      { context: 'ci / Test (blocking)', app_id: 15368 },
      { context: 'locales / Validate locale files', app_id: 15368 },
      { context: 'ci / Texts (blocking)', app_id: 15368 },
    ],
  },
  required_signatures: { url: '...', enabled: false },
  enforce_admins: { url: '...', enabled: true },
  required_linear_history: { enabled: false },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: false },
  required_conversation_resolution: { enabled: false },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
  // No `required_pull_request_reviews` and no `restrictions` key at all — GitHub omits
  // both from the GET response when neither is configured, rather than serving them null.
}

test('canonicalProtection: matches carpets\' live protection, despite the GET/PUT shape difference', () => {
  assert.equal(protectionNeedsChange(CARPETS_PROTECTION, canonicalProtection()), false)
})

test('protectionNeedsChange: no existing protection needs a change', () => {
  assert.equal(protectionNeedsChange(null), true)
})

test('protectionNeedsChange: the check list order does not matter, but the set does', () => {
  const reordered = JSON.parse(JSON.stringify(CARPETS_PROTECTION))
  reordered.required_status_checks.checks.reverse()
  assert.equal(protectionNeedsChange(reordered, canonicalProtection()), false)

  const missingOne = JSON.parse(JSON.stringify(CARPETS_PROTECTION))
  missingOne.required_status_checks.checks.pop()
  assert.equal(protectionNeedsChange(missingOne, canonicalProtection()), true)
})

test('protectionNeedsChange: enforce_admins off is a real drift', () => {
  const drifted = JSON.parse(JSON.stringify(CARPETS_PROTECTION))
  drifted.enforce_admins.enabled = false
  assert.equal(protectionNeedsChange(drifted, canonicalProtection()), true)
})

// ── The other "already in place" decisions ──────────────────────────────

test('repoFlagsNeedChange: both flags on -> no change; either missing -> change', () => {
  assert.equal(repoFlagsNeedChange({ allow_auto_merge: true, delete_branch_on_merge: true }), false)
  assert.equal(repoFlagsNeedChange({ allow_auto_merge: false, delete_branch_on_merge: true }), true)
  assert.equal(repoFlagsNeedChange({ allow_auto_merge: true, delete_branch_on_merge: false }), true)
  assert.equal(repoFlagsNeedChange(null), true)
})

test('pagesNeedsChange: build_type workflow -> no change; anything else -> change', () => {
  assert.equal(pagesNeedsChange({ build_type: 'workflow' }), false)
  assert.equal(pagesNeedsChange({ build_type: 'legacy' }), true)
  assert.equal(pagesNeedsChange(null), true)
})

test('securityFixesNeedChange / codeScanningNeedsChange', () => {
  assert.equal(securityFixesNeedChange({ enabled: true }), false)
  assert.equal(securityFixesNeedChange({ enabled: false }), true)
  assert.equal(securityFixesNeedChange(null), true)

  assert.equal(codeScanningNeedsChange({ state: 'configured' }), false)
  assert.equal(codeScanningNeedsChange({ state: 'not-configured' }), true)
  assert.equal(codeScanningNeedsChange(null), true)
})

test('repoExists: null (404) means no, any object means yes', () => {
  assert.equal(repoExists(null), false)
  assert.equal(repoExists({ full_name: 'museumwithnofrontiers/carpets' }), true)
})

// ── Placeholders: parsed from the template's own check-placeholders.js ──

// museumwithnofrontiers/website-template, scripts/check-placeholders.js, read 2026-09-21.
const CHECK_PLACEHOLDERS_SOURCE = `
import { readFileSync } from 'node:fs'

const NAME_PLACEHOLDER = '__DATASET__'
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

const TEXT_PLACEHOLDERS = {
  __SITE_CLASS__: 'the kind of website: standalone, gallery or exhibition',
  __SITE_NAMESPACE__:
    'the name this website’s own entries carry, one lowercase word ' +
    '(e.g. carpets, waterInIslam)',
}
`

// The byte-for-byte template source (unlike CHECK_PLACEHOLDERS_SOURCE above, which is
// trimmed to just the parts parseConfiguredFiles()/parseNamePlaceholder()/
// parseTextPlaceholders() read), so the integration test near the bottom of this file can
// actually execute it against a fixture tree. Kept as a sibling file
// (__fixtures__/check-placeholders.js, a verbatim copy of website-template's
// scripts/check-placeholders.js as read 2026-09-21) rather than inlined here: the source
// contains its own template-literal placeholder interpolation
// (`` `${NAME_PLACEHOLDER} is still present in:` ``), which is awkward to embed inside
// another template literal without either running it or fighting escaping — a plain file
// read has neither problem, and still keeps this test file self-contained and offline.
const CHECK_PLACEHOLDERS_JS_VERBATIM = readFileSync(
  new URL('./__fixtures__/check-placeholders.js', import.meta.url),
  'utf8'
)

test('parseConfiguredFiles: the exact file list from the template', () => {
  assert.deepEqual(parseConfiguredFiles(CHECK_PLACEHOLDERS_SOURCE), [
    'package.json',
    'vite.config.js',
    'src/dataset.config.js',
    'src/main.js',
    'src/SiteShell.vue',
    'index.html',
    'locales/en.json',
    'tests/smoke.test.js',
  ])
})

test('parseConfiguredFiles: throws a readable error if the template ever restructures this', () => {
  assert.throws(() => parseConfiguredFiles('// no CONFIGURED_FILES here'), /Could not find CONFIGURED_FILES/)
})

test('parseNamePlaceholder: __DATASET__', () => {
  assert.equal(parseNamePlaceholder(CHECK_PLACEHOLDERS_SOURCE), '__DATASET__')
})

test('parseTextPlaceholders: __SITE_CLASS__ and __SITE_NAMESPACE__', () => {
  assert.deepEqual(parseTextPlaceholders(CHECK_PLACEHOLDERS_SOURCE), ['__SITE_CLASS__', '__SITE_NAMESPACE__'])
})

test('buildReplacements: maps the three known placeholders from CLI options', () => {
  const replacements = buildReplacements(CHECK_PLACEHOLDERS_SOURCE, { slug: 'carpets', class: 'gallery', namespace: 'carpets' })
  assert.deepEqual(replacements, { __DATASET__: 'carpets', __SITE_CLASS__: 'gallery', __SITE_NAMESPACE__: 'carpets' })
})

test('buildReplacements: throws if the template ever grows a placeholder this tool does not know', () => {
  const withExtra = CHECK_PLACEHOLDERS_SOURCE.replace(
    "__SITE_CLASS__: 'the kind of website",
    "__SITE_THEME__: 'a new placeholder',\n  __SITE_CLASS__: 'the kind of website"
  )
  assert.throws(
    () => buildReplacements(withExtra, { slug: 'x', class: 'gallery', namespace: 'x' }),
    /__SITE_THEME__/
  )
})

test('applyReplacements: substitutes every occurrence, of every placeholder', () => {
  const text = '"name": "__DATASET__", "dep": "@museumwnf/__DATASET__-data", "class": "__SITE_CLASS__"'
  const out = applyReplacements(text, { __DATASET__: 'carpets', __SITE_CLASS__: 'gallery' })
  assert.equal(out, '"name": "carpets", "dep": "@museumwnf/carpets-data", "class": "gallery"')
})

// Integration-shaped: builds a small fixture tree mirroring the template's CONFIGURED_FILES,
// applies applyReplacements() to each, then runs the template's REAL check-placeholders.js
// (as fetched from website-template, byte for byte) against the result and asserts it exits
// 0 — proving this tool's substitution actually satisfies the safety net it is documented to
// rely on, not just that our own regexes agree with themselves.
test('applyReplacements + the real check-placeholders.js: a fully-replaced tree passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'new-website-placeholders-'))
  try {
    const replacements = buildReplacements(CHECK_PLACEHOLDERS_SOURCE, { slug: 'zz-fixture', class: 'gallery', namespace: 'zzFixture' })
    const files = {
      'package.json': JSON.stringify({
        name: '__DATASET__',
        // Mirrors the post-`npm install @museumwnf/<slug>-data@latest` state: the version
        // placeholder is gone by the time check-placeholders.js's preinstall hook actually
        // runs, because npm has already rewritten package.json before running it.
        dependencies: { '@museumwnf/__DATASET__-data': '^1.0.0' },
        viewerI18n: { class: '__SITE_CLASS__', namespace: '__SITE_NAMESPACE__' },
      }),
      'vite.config.js': "export default { resolve: { alias: { '@inventory-data': '@museumwnf/__DATASET__-data' } } }",
      'src/dataset.config.js': "export const datasetPackage = '@museumwnf/__DATASET__-data'",
      'src/main.js': "import bundle from '@museumwnf/viewer-i18n/__SITE_CLASS__'",
      'src/SiteShell.vue': '<template>__SITE_NAMESPACE__</template>',
      'index.html': '<title>__DATASET__</title>',
      'locales/en.json': '{ "__SITE_NAMESPACE__.about.body": "..." }',
      'tests/smoke.test.js': "import bundle from '@museumwnf/viewer-i18n/__SITE_CLASS__'",
    }
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, applyReplacements(content, replacements))
    }
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'check-placeholders.js'), CHECK_PLACEHOLDERS_JS_VERBATIM)

    // Throws (non-zero exit) if check-placeholders.js still finds a placeholder.
    assert.doesNotThrow(() => execFileSync('node', ['scripts/check-placeholders.js'], { cwd: dir, encoding: 'utf8' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── The family templates: __SITE_NAME__ and the palette ──────────────────

// museumwithnofrontiers/gallery-template, scripts/check-placeholders.js, verbatim.
const GALLERY_CHECK_PLACEHOLDERS = readFileSync(
  new URL('./__fixtures__/gallery-check-placeholders.js', import.meta.url),
  'utf8'
)

const GALLERY_PALETTE_CSS = `:root {
  --theme-dark:        __PALETTE_THEME_DARK__;
  --theme-dark-rgb:    __PALETTE_THEME_DARK_RGB__;
  --theme-medium-dark: __PALETTE_THEME_MEDIUM_DARK__;
  --theme-medium:      __PALETTE_THEME_MEDIUM__;
  --theme-light:       __PALETTE_THEME_LIGHT__;
  --background-color:  __PALETTE_BACKGROUND_COLOR__;
}
`

const CARPETS = {
  THEME_DARK: '#504819', THEME_DARK_RGB: '80, 72, 25', THEME_MEDIUM_DARK: '#6b612b',
  THEME_MEDIUM: '#7e743e', THEME_LIGHT: '#91864d', BACKGROUND_COLOR: '#fffff0',
}

test('parsePaletteFile: the family templates name theirs; website-template has none', () => {
  assert.equal(parsePaletteFile(GALLERY_CHECK_PLACEHOLDERS), 'src/styles/site.css')
  assert.equal(parsePaletteFile(CHECK_PLACEHOLDERS_JS_VERBATIM), null)
})

test('buildReplacements: a family template\'s __SITE_NAME__ is the --title', () => {
  const replacements = buildReplacements(GALLERY_CHECK_PLACEHOLDERS, { slug: 'carpets', class: 'gallery', namespace: 'carpets', title: 'Carpets' })
  assert.deepEqual(replacements, { __DATASET__: 'carpets', __SITE_NAME__: 'Carpets', __SITE_NAMESPACE__: 'carpets' })
})

test('paletteReplacements: one value per placeholder of the template, by name', () => {
  assert.deepEqual(paletteReplacements(GALLERY_PALETTE_CSS, CARPETS), {
    __PALETTE_THEME_DARK__: '#504819', __PALETTE_THEME_DARK_RGB__: '80, 72, 25', __PALETTE_THEME_MEDIUM_DARK__: '#6b612b',
    __PALETTE_THEME_MEDIUM__: '#7e743e', __PALETTE_THEME_LIGHT__: '#91864d', __PALETTE_BACKGROUND_COLOR__: '#fffff0',
  })
})

test('paletteReplacements: refuses a palette that misses a colour, names an unknown one, or is not an object', () => {
  const { THEME_LIGHT, ...missing } = CARPETS
  void THEME_LIGHT
  assert.throws(() => paletteReplacements(GALLERY_PALETTE_CSS, missing), /missing THEME_LIGHT/)
  assert.throws(() => paletteReplacements(GALLERY_PALETTE_CSS, { ...CARPETS, THEME_DRAK: '#000' }), /unknown THEME_DRAK/)
  assert.throws(() => paletteReplacements(GALLERY_PALETTE_CSS, { ...CARPETS, THEME_DARK: ' ' }), /missing THEME_DARK/)
  assert.throws(() => paletteReplacements(GALLERY_PALETTE_CSS, ['#504819']), /must be a JSON object/)
})

// The gallery template's REAL guard, run against a scaffolded tree: with the palette
// replaced it passes; with the palette left, it refuses — the install cannot go ahead
// on another gallery's colours or on none.
test('the real gallery guard: passes a scaffolded tree, refuses one whose palette is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'new-website-gallery-'))
  try {
    const replacements = buildReplacements(GALLERY_CHECK_PLACEHOLDERS, { slug: 'zz-fixture', class: 'gallery', namespace: 'zzFixture', title: 'Fixture' })
    const files = {
      'package.json': JSON.stringify({ name: '__DATASET__', dependencies: { '@museumwnf/__DATASET__-data': '^1.0.0' } }),
      'vite.config.js': "export default { dataPackage: '@museumwnf/__DATASET__-data' }",
      'index.html': '<title>__SITE_NAME__</title>',
      'src/dataset.config.js': "export default { datasetPackage: '@museumwnf/__DATASET__-data', siteName: '__SITE_NAME__' }",
      'locales/en.json': '{ "__SITE_NAMESPACE__.credits.body": "..." }',
      'tests/smoke.test.js': "const ns = '__SITE_NAMESPACE__'",
    }
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, applyReplacements(content, replacements))
    }
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'check-placeholders.js'), GALLERY_CHECK_PLACEHOLDERS)
    const paletteFile = join(dir, parsePaletteFile(GALLERY_CHECK_PLACEHOLDERS))
    mkdirSync(dirname(paletteFile), { recursive: true })
    const guard = () => execFileSync('node', ['scripts/check-placeholders.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })

    writeFileSync(paletteFile, GALLERY_PALETTE_CSS)
    assert.throws(guard, /palette in src\/styles\/site\.css is not set/)

    writeFileSync(paletteFile, applyReplacements(GALLERY_PALETTE_CSS, paletteReplacements(GALLERY_PALETTE_CSS, CARPETS)))
    assert.doesNotThrow(guard)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})