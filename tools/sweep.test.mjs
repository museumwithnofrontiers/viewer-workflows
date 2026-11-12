import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { parseArgs, selectSites, validateChange } from './sweep.mjs'

const SITES = [
  { repo: 'museumwithnofrontiers/carpets', template: 'gallery-template' },
  { repo: 'museumwithnofrontiers/islamicart-women', template: 'minisite-template' },
  { repo: 'museumwithnofrontiers/baroqueart-devotion', template: 'baroqueart-minisite-template' },
]

const CHANGE = { branch: 'chore/sweep-example', title: 'Example', body: 'Why.', apply: () => {} }

test('parseArgs: --change is required', () => {
  assert.throws(() => parseArgs(['--dry-run']), /--change <file> is required/)
})

test('parseArgs: repeatable families and repos, flags', () => {
  const options = parseArgs(['--change', 'sweeps/x.mjs', '--family', 'gallery-template', '--family', 'minisite-template',
    '--repo', 'o/a', '--dry-run', '--verify', '--out', 'diffs', '--no-merge'])
  assert.deepEqual(options.families, ['gallery-template', 'minisite-template'])
  assert.deepEqual(options.repos, ['o/a'])
  assert.equal(options.dryRun, true)
  assert.equal(options.verify, true)
  assert.equal(options.out, 'diffs')
  assert.equal(options.merge, false)
})

test('parseArgs: an unknown argument is refused', () => {
  assert.throws(() => parseArgs(['--change', 'x', '--force']), /Unknown argument: --force/)
})

test('validateChange: names every missing export', () => {
  assert.throws(() => validateChange({}, 'sweeps/x.mjs'), /must export branch, title, body, apply\(\)/)
})

test("validateChange: the branch must be the sweep's own", () => {
  assert.throws(() => validateChange({ ...CHANGE, branch: 'chore/propagate-platform-packages' }), /must start with "chore\/sweep-"/)
})

test('validateChange: families must be a list', () => {
  assert.throws(() => validateChange({ ...CHANGE, families: 'gallery-template' }), /families must be an array/)
  assert.equal(validateChange({ ...CHANGE, families: ['gallery-template'] }).branch, 'chore/sweep-example')
})

test('selectSites: by family, by repo, or every site', () => {
  assert.deepEqual(selectSites(SITES, ['minisite-template'], []).map((s) => s.repo), ['museumwithnofrontiers/islamicart-women'])
  assert.deepEqual(selectSites(SITES, [], ['museumwithnofrontiers/carpets']).map((s) => s.repo), ['museumwithnofrontiers/carpets'])
  assert.equal(selectSites(SITES, [], []).length, 3)
})

test('selectSites: selecting nothing throws instead of succeeding quietly', () => {
  assert.throws(() => selectSites(SITES, ['exhibition-template'], []), /No website matches/)
})
