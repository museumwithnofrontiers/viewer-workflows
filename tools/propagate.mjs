#!/usr/bin/env node
/**
 * Propagate published @museumwnf packages to every MWNF website.
 *
 * This is step 3 of the release flow in MAINTENANCE.md, and the one step a
 * human triggers. Everything before it is CI; everything after it is CI.
 *
 * Why this exists rather than Dependabot: propagation is the one point in the
 * release flow where a human decides *when* a new version reaches sites, not
 * a mechanical version bump — see MAINTENANCE.md's rule 3. So the
 * @museumwnf scope is deliberately excluded from each site's dependabot.yml
 * and propagated here instead, using the operator's own credentials, which
 * are already on their machine and are never written anywhere.
 *
 * Usage:
 *   node tools/propagate.mjs --expect viewer-core@1.0.0 [--expect viewer-layout@1.0.0]
 *   node tools/propagate.mjs --expect carpets-data@1.1.0 --repo museumwithnofrontiers/carpets
 *   node tools/propagate.mjs --expect viewer-core@1.0.0 --dry-run
 *
 * Options:
 *   --expect <name>@<version>  REQUIRED, repeatable. Refuses to run until the
 *                              registry actually serves this version. Without
 *                              it a run started before the publish workflow
 *                              finished would resolve `latest` to the previous
 *                              version, bump nothing, and exit 0 — a silent
 *                              no-op that looks like success.
 *   --repo <owner/name>        Restrict to one site. Repeatable. Also the
 *                              escape hatch for a site the discovery below
 *                              cannot see.
 *   --owner <login-or-org>     The account whose repositories discovery
 *                              searches for sites created from
 *                              website-template. Defaults to the `origin`
 *                              remote of the checkout this script runs from
 *                              — see resolveOwner() — which must be a
 *                              property of the estate, never the login of
 *                              whoever is running the tool. Ignored when
 *                              every site is named with --repo.
 *   --dry-run                  Resolve and report; touch nothing.
 *   --no-merge                 Open the pull requests but do not enable
 *                              auto-merge.
 *
 * Requires: `gh` authenticated as the operator. Package versions are read
 * from the public npmjs registry, which needs no credential of its own. This
 * tool never reads a token from the environment and never prints one — but
 * `gh` itself may: on the operator's own machine `gh auth login` normally
 * stores the token in the OS keyring, which a container cannot reach. Run in
 * Docker with `-e GH_TOKEN=$(gh auth token)`; mounting `~/.config/gh` alone
 * carries no usable token when the host's `gh` uses keyring storage. This
 * tool runs `gh auth setup-git` itself on every invocation (cheap,
 * idempotent) so `git push` authenticates the same way `gh` does, and it
 * fails fast with a clear message if `gh` itself is not authenticated,
 * rather than surfacing a cryptic mid-run push error.
 *
 * The same disposable container has no git commit identity either — no
 * ~/.gitconfig, no GIT_AUTHOR_NAME/EMAIL or GIT_COMMITTER_NAME/EMAIL env.
 * resolveGitIdentity() below establishes one with the same "fail fast, once,
 * up front" shape as ensureGhAuth(), rather than letting `git commit` fail
 * per site.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  SCOPE,
  SITE_TEMPLATES,
  ensureGhAuth,
  gh,
  gitIdentityArgs,
  hasLocalGitIdentity,
  isSiteTemplate,
  ownerFromRemoteUrl,
  resolveGitIdentity,
  resolveOwner,
  run,
} from './gh-lib.mjs'

const BRANCH = 'chore/propagate-platform-packages'

// ── Arguments ──────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const expect = []
  const repos = []
  let owner = null
  let dryRun = false
  let merge = true
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--expect') expect.push(argv[++i])
    else if (arg === '--repo') repos.push(argv[++i])
    else if (arg === '--owner') owner = argv[++i]
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--no-merge') merge = false
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!expect.length) {
    throw new Error(
      '--expect <package>@<version> is required.\n' +
      'It is what stops a run started before the publish workflow finished from ' +
      'silently propagating nothing.'
    )
  }
  return { expect, repos, owner, dryRun, merge }
}

// ── Preconditions ──────────────────────────────────────────────────────────

/** A bare package name given on the command line, qualified with SCOPE. A name already carrying its own scope (e.g. a one-off `@other/pkg`) passes through unchanged. */
export function expandPackageName(name, scope = SCOPE) {
  return name.startsWith('@') ? name : `${scope}/${name}`
}

/**
 * Refuse to start unless the registry already serves every expected version.
 *
 * `npm view` resolves against the public npmjs registry, which these packages
 * need no credential to read. A failure here is almost always the same thing,
 * and the message says so: the publish workflow has not finished yet.
 */
function verifyPublished(expect) {
  for (const spec of expect) {
    const at = spec.lastIndexOf('@')
    if (at <= 0) throw new Error(`--expect must be <package>@<version>, got "${spec}"`)
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    const full = expandPackageName(name)
    let published
    try {
      published = run('npm', ['view', `${full}@${version}`, 'version'])
    } catch {
      throw new Error(
        `${full}@${version} is not on the registry.\n` +
        '  · If you have just merged the release PR, the publish workflow may still be running —\n' +
        '    it is triggered by publishing the GitHub Release, not by the merge.\n' +
        '  · Otherwise double-check the package name and version.'
      )
    }
    if (published !== version) {
      throw new Error(`${full}: registry served ${published}, expected ${version}`)
    }
    console.log(`  verified ${full}@${version}`)
  }
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Filters candidate repo names down to the sites actually created from one of
 * `owner`'s site templates (`SITE_TEMPLATES`), sorted — or throws if none match.
 *
 * `getTemplate(name)` is injected rather than calling `gh` here directly, the
 * same way resolveGitIdentity() takes `hasLocalIdentity` instead of shelling
 * out to `git config` itself: it lets this decision logic — including the
 * zero-match failure below — be tested without a network call or a real `gh`.
 *
 * Throws when nothing matches, rather than returning an empty list: a
 * propagation that touches zero sites must never report success (that used
 * to be exactly what happened whenever `owner` was wrong, e.g. pointed at an
 * account that no longer holds the estate) — it must fail loudly enough that
 * the operator can see it, right there, before the run declares victory.
 */
export function buildSiteList(owner, names, getTemplate) {
  const expected = SITE_TEMPLATES.map((name) => `"${owner}/${name}"`).join(', ')
  const sites = names
    .filter((name) => isSiteTemplate(owner, getTemplate(name)))
    .map((name) => `${owner}/${name}`)

  if (!sites.length) {
    throw new Error(
      `Discovered 0 websites under owner "${owner}" (searched ${names.length} of its ` +
      `repositories for a template_repository among ${expected}).\n` +
      '  · This is almost always a wrong owner, not an empty estate — e.g. the estate\n' +
      '    moved to a different account/org and this ran against the old one.\n' +
      '  · Pass --owner <login-or-org> explicitly, or --repo <owner/name> to target\n' +
      '    sites directly, bypassing discovery entirely.'
    )
  }

  return sites.sort()
}

/**
 * Every website, derived from the template link GitHub records permanently.
 *
 * The same rule drives package-ci.yml's downstream matrix, so the set of
 * repositories validated before a release and the set updated after it cannot
 * drift apart. There is no list to maintain.
 *
 * Blind spot, accepted knowingly: this finds repositories OWNED by `owner`
 * that still carry the link. A site created by fork or transferred in is
 * invisible — pass it with --repo.
 */
function discoverSites(owner) {
  console.log(`Discovering websites created from ${SITE_TEMPLATES.map((name) => `${owner}/${name}`).join(', ')}`)

  const names = gh([
    'api', `users/${owner}/repos?per_page=100&type=owner`, '--paginate',
    '--jq', '.[] | select(.archived == false) | .name',
  ]).split('\n').filter(Boolean)

  const sites = buildSiteList(owner, names, (name) => gh([
    'api', `repos/${owner}/${name}`, '--jq', '.template_repository.full_name // ""',
  ]))
  const { ready, skipped } = scaffoldedOnly(sites, hasLockFile)
  for (const site of skipped) console.log(`  skipped, not yet scaffolded: ${site}`)
  return ready
}

/**
 * A site whose scaffold pull request has not merged yet carries the template's
 * tree without a `package-lock.json` on its default branch: there is nothing
 * to bump there yet, and package-ci.yml leaves it out of its downstream matrix
 * for the same reason (museumwithnofrontiers/viewer-workflows#30). Skipped
 * sites are named, so the drop is visible.
 *
 * `hasLockFile(site)` is injected, as `getTemplate` is in buildSiteList().
 */
export function scaffoldedOnly(sites, hasLockFile) {
  const ready = []
  const skipped = []
  for (const site of sites) (hasLockFile(site) ? ready : skipped).push(site)
  return { ready, skipped }
}

function hasLockFile(site) {
  try {
    gh(['api', `repos/${site}/contents/package-lock.json`, '--silent'], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

// ── Per-site work ──────────────────────────────────────────────────────────

/** Every SCOPE-namespaced dependency a site declares, from its own manifest. */
export function scopedDeps(dir, scope = SCOPE) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => name.startsWith(`${scope}/`))
    .sort()
}

/**
 * What to do when the site already carries a BRANCH. That branch name belongs
 * to this tool — nothing else pushes to it — so a leftover is one of two
 * things, told apart by whether a pull request is still open on it:
 *   - open PR: an earlier propagation has not landed (red CI waiting for a
 *     person, or simply not merged yet). Leave it alone and report it; pushing
 *     over it would silently rewrite a pull request someone may be reading.
 *   - no open PR: the branch survived its merged (or closed) pull request
 *     because the site repository does not delete branches on merge. Nothing
 *     on it is worth keeping: replace it.
 * Before this distinction existed the second case rejected the push with
 * "fetch first" on every site without delete-branch-on-merge, and the only
 * remedy was deleting the branch by hand and rerunning the tool per site.
 */
export function existingBranchAction(openPullRequests) {
  return openPullRequests.length
    ? { action: 'skip', url: openPullRequests[0].url }
    : { action: 'replace' }
}

function propagateTo(repo, { dryRun, merge, identityArgs }) {
  const work = mkdtempSync(join(tmpdir(), 'propagate-'))
  try {
    gh(['repo', 'clone', repo, work, '--', '--depth', '1'], { stdio: 'pipe' })

    const deps = scopedDeps(work)
    if (!deps.length) return { repo, status: 'skipped', detail: `no ${SCOPE} dependencies` }

    const before = readFileSync(join(work, 'package-lock.json'), 'utf8')

    // `npm install <pkg>@latest` rather than `npm update`: update only moves
    // within the declared range, so it would silently do nothing whenever a
    // release falls outside it — which is every minor release while a package
    // is still 0.x. install@latest rewrites the range as well as the lockfile,
    // which is what "adopt the published version" actually means.
    run('npm', ['install', ...deps.map((d) => `${d}@latest`), '--no-audit', '--no-fund'], {
      cwd: work,
      stdio: 'pipe',
    })

    const after = readFileSync(join(work, 'package-lock.json'), 'utf8')
    if (before === after) return { repo, status: 'current', detail: 'already at latest' }

    const versions = deps
      .map((d) => {
        const pkg = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'))
        return `${d}@${(pkg.dependencies?.[d] ?? pkg.devDependencies?.[d] ?? '').replace('^', '')}`
      })
      .join(', ')

    if (dryRun) return { repo, status: 'would-update', detail: versions }

    const open = JSON.parse(
      gh(['pr', 'list', '--repo', repo, '--head', BRANCH, '--state', 'open', '--json', 'url'], { cwd: work })
    )
    const existing = existingBranchAction(open)
    if (existing.action === 'skip') {
      return { repo, status: 'pending', detail: `an earlier propagation is still open: ${existing.url}` }
    }

    run('git', ['checkout', '-b', BRANCH], { cwd: work, stdio: 'pipe' })
    run('git', ['add', 'package.json', 'package-lock.json'], { cwd: work, stdio: 'pipe' })

    // Outside the clone: a file written inside it would be an untracked change,
    // and `gh pr create` warns about a dirty tree.
    const body = join(tmpdir(), `propagate-message-${process.pid}`)
    writeFileSync(
      body,
      `chore(deps): adopt the published ${SCOPE} packages\n\n` +
      `${versions}\n\n` +
      'Opened by tools/propagate.mjs in museumwithnofrontiers/viewer-workflows. The release\n' +
      'was already built against this site by the package repository\'s own CI\n' +
      'before it was published; this pull request re-runs that check here, in\n' +
      'context, before the site adopts it.\n'
    )
    run('git', [...identityArgs, 'commit', '-F', body], { cwd: work, stdio: 'pipe' })
    // `--force`, not `--force-with-lease`: the shallow clone above fetched only
    // the default branch, so there is no remote-tracking ref to hold a lease
    // against. The safety is existingBranchAction(): by the time this push
    // runs, whatever the remote BRANCH holds is a leftover with no open pull
    // request, which is exactly what `replace` means.
    run('git', ['push', '--force', '-u', 'origin', BRANCH], { cwd: work, stdio: 'pipe' })

    // --head is required alongside --repo: with an explicit repo, `gh` does not
    // infer the branch from the working directory.
    const url = gh(['pr', 'create', '--repo', repo, '--head', BRANCH, '--fill'], { cwd: work })
    if (merge) gh(['pr', 'merge', url, '--repo', repo, '--auto', '--squash'], { cwd: work })

    return { repo, status: dryRun ? 'would-update' : 'opened', detail: url }
  } catch (error) {
    // One site failing must not stop the rest; the summary reports it.
    const message = String(error.stderr || error.message).split('\n').slice(0, 3).join(' ')
    return { repo, status: 'failed', detail: message }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

// Guarded so a test can `import` this module for its pure helpers
// (parseArgs, expandPackageName, scopedDeps, buildSiteList,
// existingBranchAction — the gh/git plumbing they used to share with
// new-website.mjs now lives in ./gh-lib.mjs) without running the CLI —
// which talks to `gh` and the registry from its very first line.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { expect, repos, owner, dryRun, merge } = parseArgs(process.argv.slice(2))

  console.log('Checking gh authentication')
  ensureGhAuth()

  // Fetched once and reused for deriving a git commit identity (login + id) — see
  // resolveGitIdentity(). Site discovery does NOT use this: see resolveOwner(), which
  // deliberately never derives the estate's owner from whoever is authenticated.
  const user = JSON.parse(gh(['api', 'user']))

  console.log('Resolving a git commit identity')
  const identity = resolveGitIdentity(user, process.env, hasLocalGitIdentity())
  console.log(identity
    ? `  none found; committing as ${identity.name} <${identity.email}>`
    : '  using the existing git identity')
  const identityArgs = gitIdentityArgs(identity)

  console.log('Verifying the registry serves the expected versions')
  verifyPublished(expect)

  const sites = repos.length ? repos : discoverSites(resolveOwner(owner))
  console.log(`\n${sites.length} website(s):`)
  for (const site of sites) console.log(`  ${site}`)

  console.log(`\nPropagating${dryRun ? ' (dry run)' : ''}`)
  const results = sites.map((site) => {
    const result = propagateTo(site, { dryRun, merge, identityArgs })
    console.log(`  ${result.status.padEnd(12)} ${result.repo}  ${result.detail}`)
    return result
  })

  const failed = results.filter((r) => r.status === 'failed')
  const pending = results.filter((r) => r.status === 'pending')
  console.log(`\n${results.filter((r) => r.status === 'opened').length} opened, ` +
    `${results.filter((r) => r.status === 'current').length} already current, ` +
    `${pending.length} pending, ${failed.length} failed`)

  // Not a failure of this run: the site is waiting on a person to merge or
  // close the earlier pull request, and that decision is not the tool's.
  if (pending.length) {
    console.log('\nPending (merge or close the earlier pull request, then rerun with --repo):')
    for (const p of pending) console.log(`  ${p.repo}: ${p.detail}`)
  }

  if (failed.length) {
    console.log('\nFailed:')
    for (const f of failed) console.log(`  ${f.repo}: ${f.detail}`)
    process.exit(1)
  }
}
