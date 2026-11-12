#!/usr/bin/env node
/**
 * Apply one scripted change to the files of every website of a family, one
 * pull request per site, merged automatically when the site's CI is green.
 *
 * propagate.mjs moves a site to a newly published package version and touches
 * nothing else. A platform change that also needs every site to change its own
 * files — a new configuration factory, a shared test suite, a file the
 * templates no longer need — used to take a one-off script each time. This is
 * that script, once: the change itself is a small module under sweeps/, kept
 * in this repository so what was done to the estate stays readable.
 *
 * Usage:
 *   node tools/sweep.mjs --change sweeps/<change>.mjs --dry-run [--out <dir>]
 *   node tools/sweep.mjs --change sweeps/<change>.mjs [--family minisite-template] [--repo owner/name]
 *
 * Options:
 *   --change <file>     REQUIRED. The change module (see "The change module").
 *   --family <template> Only the sites created from this template (e.g.
 *                       `gallery-template`). Repeatable. Defaults to the
 *                       module's own `families`, else every website.
 *   --repo <owner/name> Restrict to these sites. Repeatable. Bypasses discovery.
 *   --owner <login>     As in propagate.mjs: the estate's owner, by default the
 *                       `origin` remote of this checkout.
 *   --dry-run           Apply the change in a throwaway clone, report what it
 *                       changed, push nothing.
 *   --verify            After applying, run the site's `npm ci`, `npm run
 *                       lint`, `npm test` and `npm run build`; a site whose
 *                       tests or build fail (lint only reports, as in CI)
 *                       gets no pull request. Slow: meant with --dry-run
 *                       on a few sites before the real run.
 *   --out <dir>         Write each changed site's diff to <dir>/<site>.diff.
 *   --no-merge          Open the pull requests without enabling auto-merge.
 *
 * The change module exports:
 *   branch    the branch it pushes, `chore/sweep-<name>`, owned by this change;
 *   title     the commit's and the pull request's title;
 *   body      the pull request's description: why, in a few lines;
 *   families  (optional) the templates whose sites it concerns;
 *   apply(ctx) the change. `ctx` is `{ dir, repo, name, template, install }`:
 *              the clone, `owner/name`, the bare name, the template the site
 *              was created from, and `install(...specs)`, which runs
 *              `npm install` in the clone. It edits files under `dir` with
 *              node:fs. Returning a string skips the site with that reason.
 * A site the change leaves untouched is reported `current` and gets nothing.
 *
 * Requires `gh` authenticated as the operator; run it in Docker exactly as
 * propagate.mjs (MAINTENANCE.md, "Step 3, with the tool").
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  discoverWebsites,
  ensureGhAuth,
  gh,
  gitIdentityArgs,
  hasLocalGitIdentity,
  resolveGitIdentity,
  resolveOwner,
  run,
} from './gh-lib.mjs'
import { existingBranchAction } from './propagate.mjs'

// ── Arguments ──────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = { change: null, families: [], repos: [], owner: null, dryRun: false, verify: false, out: null, merge: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--change') options.change = argv[++i]
    else if (arg === '--family') options.families.push(argv[++i])
    else if (arg === '--repo') options.repos.push(argv[++i])
    else if (arg === '--owner') options.owner = argv[++i]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--verify') options.verify = true
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--no-merge') options.merge = false
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.change) throw new Error('--change <file> is required: the sweeps/ module to apply.')
  return options
}

/**
 * Refuse a change module that lacks what every pull request needs, before any
 * site is cloned. The branch must be the change's own: a sweep pushing to
 * propagate.mjs's branch, or to another sweep's, would overwrite its work.
 */
export function validateChange(change, file = 'the change module') {
  const missing = ['branch', 'title', 'body'].filter((key) => typeof change[key] !== 'string' || !change[key].trim())
  if (typeof change.apply !== 'function') missing.push('apply()')
  if (missing.length) throw new Error(`${file} must export ${missing.join(', ')}.`)
  if (!change.branch.startsWith('chore/sweep-')) {
    throw new Error(`${file}: branch must start with "chore/sweep-" (got "${change.branch}").`)
  }
  if (change.families !== undefined && !Array.isArray(change.families)) {
    throw new Error(`${file}: families must be an array of template names.`)
  }
  return change
}

/**
 * The sites a run concerns: those created from one of `families` (all, when
 * none is given), narrowed to `repos` when any is named. A run that selects no
 * site throws, for the reason buildSiteList() does: zero must never look like
 * a quiet success.
 */
export function selectSites(sites, families, repos) {
  const selected = sites
    .filter((site) => !families.length || families.includes(site.template))
    .filter((site) => !repos.length || repos.includes(site.repo))
  if (!selected.length) {
    throw new Error(
      `No website matches (families: ${families.join(', ') || 'any'}; repos: ${repos.join(', ') || 'any'}).\n` +
      '  · Check the template names (gallery-template, exhibition-template, website-template,\n' +
      '    minisite-template, baroqueart-minisite-template, sharinghistory-minisite-template).'
    )
  }
  return selected
}

// ── Per-site work ──────────────────────────────────────────────────────────

async function sweepSite(site, change, { dryRun, verify, out, merge, identityArgs, changeFile }) {
  const work = mkdtempSync(join(tmpdir(), 'sweep-'))
  const name = site.repo.split('/')[1]
  try {
    gh(['repo', 'clone', site.repo, work, '--', '--depth', '1'], { stdio: 'pipe' })

    const install = (...specs) => run('npm', ['install', ...specs, '--no-audit', '--no-fund'], { cwd: work, stdio: 'pipe' })
    const skipped = await change.apply({ dir: work, repo: site.repo, name, template: site.template, install })
    if (typeof skipped === 'string') return { repo: site.repo, status: 'skipped', detail: skipped }

    if (!run('git', ['status', '--porcelain'], { cwd: work })) {
      return { repo: site.repo, status: 'current', detail: 'nothing to change' }
    }
    run('git', ['add', '-A'], { cwd: work, stdio: 'pipe' })
    const stat = run('git', ['diff', '--cached', '--shortstat'], { cwd: work })
    if (out) {
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, `${name}.diff`), run('git', ['diff', '--cached'], { cwd: work, maxBuffer: 64 * 1024 * 1024 }) + '\n')
    }

    let lintNote = ''
    if (verify) {
      for (const script of [['ci'], ['run', 'lint'], ['test'], ['run', 'build']]) {
        try {
          run('npm', [...script, ...(script[0] === 'ci' ? ['--no-audit', '--no-fund'] : [])], { cwd: work, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
        } catch (error) {
          // ESLint only reports, as in the sites' CI (website-ci.yml): a site
          // whose lint already failed before the change is not refused for it.
          if (script[1] === 'lint') {
            lintNote = ' (lint reports problems)'
            continue
          }
          const tail = String(error.stdout || '').split('\n').slice(-15).join('\n')
          return { repo: site.repo, status: 'failed', detail: `npm ${script.join(' ')} failed:\n${tail}` }
        }
      }
    }

    if (dryRun) return { repo: site.repo, status: verify ? 'verified' : 'would-change', detail: stat + lintNote }

    const open = JSON.parse(gh(['pr', 'list', '--repo', site.repo, '--head', change.branch, '--state', 'open', '--json', 'url'], { cwd: work }))
    const existing = existingBranchAction(open)
    if (existing.action === 'skip') {
      return { repo: site.repo, status: 'pending', detail: `this change is already open: ${existing.url}` }
    }

    run('git', ['checkout', '-b', change.branch], { cwd: work, stdio: 'pipe' })
    const message = join(tmpdir(), `sweep-message-${process.pid}`)
    writeFileSync(message, `${change.title}\n\n${change.body.trim()}\n\nOpened by tools/sweep.mjs in museumwithnofrontiers/viewer-workflows (${changeFile}).\n`)
    run('git', [...identityArgs, 'commit', '-F', message], { cwd: work, stdio: 'pipe' })
    // As in propagate.mjs: a shallow clone holds no lease to force against, and
    // existingBranchAction() has already ruled out an open pull request.
    run('git', ['push', '--force', '-u', 'origin', change.branch], { cwd: work, stdio: 'pipe' })

    const url = gh(['pr', 'create', '--repo', site.repo, '--head', change.branch, '--fill'], { cwd: work })
    if (merge) gh(['pr', 'merge', url, '--repo', site.repo, '--auto', '--squash'], { cwd: work })
    return { repo: site.repo, status: 'opened', detail: `${url} (${stat})` }
  } catch (error) {
    const message = String(error.stderr || error.message).split('\n').slice(0, 3).join(' ')
    return { repo: site.repo, status: 'failed', detail: message }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const changeFile = `sweeps/${basename(options.change)}`
  const change = validateChange(await import(pathToFileURL(resolve(options.change)).href), changeFile)
  const families = options.families.length ? options.families : (change.families ?? [])

  console.log('Checking gh authentication')
  ensureGhAuth()
  const user = JSON.parse(gh(['api', 'user']))
  const identityArgs = gitIdentityArgs(resolveGitIdentity(user, process.env, hasLocalGitIdentity()))

  const sites = selectSites(discoverWebsites(resolveOwner(options.owner)), families, options.repos)
  console.log(`\n${change.title}\n${sites.length} website(s)${families.length ? ` from ${families.join(', ')}` : ''}${options.dryRun ? ' (dry run)' : ''}`)

  const results = []
  for (const site of sites) {
    const result = await sweepSite(site, change, { ...options, identityArgs, changeFile })
    console.log(`  ${result.status.padEnd(12)} ${result.repo}  ${result.detail}`)
    results.push(result)
  }

  const count = (status) => results.filter((r) => r.status === status).length
  console.log(`\n${count('opened')} opened, ${count('would-change') + count('verified')} would change, ` +
    `${count('current')} current, ${count('skipped')} skipped, ${count('pending')} pending, ${count('failed')} failed`)
  if (count('failed')) process.exit(1)
}
