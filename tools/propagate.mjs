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

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCOPE = '@museumwnf'
export const TEMPLATE_REPO = 'website-template'
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

// ── Shell helpers ──────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()
}

function gh(args, opts = {}) {
  return run('gh', args, opts)
}

// ── Preconditions ──────────────────────────────────────────────────────────

/**
 * Fail fast, with an actionable message, if `gh` cannot authenticate — and
 * make sure `git push` will use that same authentication.
 *
 * Without this, the first symptom of a missing/unreachable token used to
 * surface deep in the first site's `git push` as a bare credential-helper
 * error ("could not read Username"), after discovery and the registry check
 * had already run. `gh auth setup-git` installs `gh` as git's credential
 * helper for its hosts (idempotent — safe to run on every invocation, on the
 * operator's own machine or in a fresh container alike), so a plain `git
 * push` in propagateTo() authenticates the same way `gh pr create` does.
 */
function ensureGhAuth() {
  try {
    gh(['auth', 'status'])
  } catch (error) {
    throw new Error(
      'gh is not authenticated (`gh auth status` failed).\n' +
      '  · On the operator\'s own machine: run `gh auth login`.\n' +
      '  · In a container: `gh auth login` on the host commonly stores the token in\n' +
      '    the OS keyring (e.g. Windows Credential Manager), which the container\n' +
      '    cannot reach — mounting ~/.config/gh alone carries no usable token then.\n' +
      '    Pass the token instead: docker run -e GH_TOKEN=$(gh auth token) ...\n' +
      String(error.stderr || error.message)
    )
  }
  try {
    gh(['auth', 'setup-git'])
  } catch (error) {
    throw new Error(`gh auth setup-git failed: ${String(error.stderr || error.message)}`)
  }
}

/** Whether `git config` already resolves both `user.name` and `user.email` — a real
 * developer machine, or a container someone configured ahead of time. Config only:
 * GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL are environment overrides that
 * `git config --get` does not see, which is why resolveGitIdentity() below checks them as
 * a separate, higher-precedence step rather than folding them in here. */
function hasLocalGitIdentity() {
  try {
    run('git', ['config', '--get', 'user.name'])
    run('git', ['config', '--get', 'user.email'])
    return true
  } catch {
    return false
  }
}

/**
 * Decide whether `git commit` already has an author identity to work with, and if not,
 * derive one — so the tool remains usable in the disposable container it is documented to
 * run in (see file header), which starts with neither.
 *
 * Precedence, and why:
 *   1. GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL already set in the environment:
 *      git already reads these for every commit, and an operator who exported them on
 *      purpose should win over anything this tool would guess.
 *   2. `git config user.name`/`user.email` already resolve: leave them alone, the same way
 *      ensureGhAuth() above leaves an existing `gh auth login` alone rather than
 *      re-authenticating over it.
 *   3. Otherwise, derive one from the GitHub identity this tool already has to
 *      authenticate — `user`, the `gh api user` response fetched once in main() and reused
 *      here. `login` and the numeric `id` give the conventional GitHub no-reply address, so
 *      a commit made through this tool is attributed to whoever ran it rather than to an
 *      anonymous default, which matters because these commits land as PRs across the
 *      estate.
 *
 * Returns `null` when an identity already exists (cases 1–2, nothing to do), or
 * `{ name, email }` derived from the GitHub account (case 3). Throws, once, up front —
 * before any site is touched — if none of the above can supply one, rather than letting
 * `git commit` fail with the same opaque error again for every site in turn.
 */
export function resolveGitIdentity(user, env, hasLocalIdentity) {
  const hasEnvIdentity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
    .every((key) => env[key])
  if (hasEnvIdentity || hasLocalIdentity) return null

  if (!user?.login || !user?.id) {
    throw new Error(
      'No git commit identity is available, and none could be derived.\n' +
      '  · Set GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL and GIT_COMMITTER_NAME/GIT_COMMITTER_EMAIL, or\n' +
      '  · run `git config --global user.name`/`user.email` in this container, or\n' +
      '  · make sure `gh api user` returns a "login" and numeric "id" (it already must, for\n' +
      '    gh itself to be authenticated).'
    )
  }

  return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` }
}

/** `git -c user.name=... -c user.email=...` arguments to prepend to a single `commit`
 * invocation for a derived identity, or `[]` to change nothing when `identity` is `null`
 * (git already has one). Per-invocation rather than `git config --global`: this tool should
 * not reconfigure the machine or container it happens to run in. */
export function gitIdentityArgs(identity) {
  return identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : []
}

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

// ── Owner resolution ─────────────────────────────────────────────────────

/**
 * The GitHub owner (user or org) that discoverSites() searches under, and that a
 * candidate site's `template_repository` is checked against.
 *
 * This must be a property of the estate — the account that currently owns
 * `website-template` and the sites created from it — never the login of
 * whoever happens to be running the tool. Before this existed, the owner was
 * `gh api user`'s login: that already matches nothing for any collaborator
 * whose own account does not own the sites, and it will match nothing for
 * *everyone* the day the estate moves from the personal account `metanull` to
 * the org `museumwithnofrontiers`.
 *
 * Precedence:
 *   1. `--owner`, explicit and authoritative — the escape hatch for a
 *      checkout without a usable `origin`, or a deliberate one-off run
 *      against a different estate.
 *   2. The `origin` remote of the git checkout this script is running from.
 *      MAINTENANCE.md's documented invocation mounts an existing
 *      viewer-workflows checkout into the container and runs the script from
 *      its root (`-v "$PWD:/w" -w /w ... node tools/propagate.mjs`), so that
 *      checkout's own remote already names the estate's current owner — and
 *      keeps naming it correctly across the org move, since re-cloning from
 *      the new location is the thing that actually performs that move for
 *      the operator, with nothing to update in this tool.
 */
export function resolveOwner(explicitOwner, cwd = process.cwd()) {
  if (explicitOwner) return explicitOwner

  let url
  try {
    url = run('git', ['remote', 'get-url', 'origin'], { cwd })
  } catch (error) {
    throw new Error(
      'Could not determine the GitHub owner to search under: `git remote get-url origin`\n' +
      `failed in ${cwd}.\n` +
      '  · Pass --owner <login-or-org> explicitly, or\n' +
      '  · run this from within a checkout of viewer-workflows that has an `origin`\n' +
      `    remote pointing at GitHub.\n${String(error.stderr || error.message)}`
    )
  }

  const owner = ownerFromRemoteUrl(url)
  if (!owner) {
    throw new Error(
      `Could not parse a GitHub owner out of the \`origin\` remote "${url}".\n` +
      '  · Pass --owner <login-or-org> explicitly instead.'
    )
  }
  return owner
}

/**
 * Pulls the owner out of a GitHub remote URL, SSH or HTTPS alike:
 * "git@github.com:owner/repo.git" and "https://github.com/owner/repo" both give "owner".
 * Returns null for a remote that isn't a github.com URL at all.
 */
export function ownerFromRemoteUrl(url) {
  const match = url.match(/github\.com[:/]([^/]+)\//)
  return match ? match[1] : null
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Filters candidate repo names down to the sites actually created from
 * `owner/TEMPLATE_REPO`, sorted — or throws if none match.
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
  const expected = `${owner}/${TEMPLATE_REPO}`
  const sites = names
    .filter((name) => getTemplate(name) === expected)
    .map((name) => `${owner}/${name}`)

  if (!sites.length) {
    throw new Error(
      `Discovered 0 websites under owner "${owner}" (searched ${names.length} of its ` +
      `repositories for template_repository = "${expected}").\n` +
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
  console.log(`Discovering websites created from ${owner}/${TEMPLATE_REPO}`)

  const names = gh([
    'api', `users/${owner}/repos?per_page=100&type=owner`, '--paginate',
    '--jq', '.[] | select(.archived == false) | .name',
  ]).split('\n').filter(Boolean)

  return buildSiteList(owner, names, (name) => gh([
    'api', `repos/${owner}/${name}`, '--jq', '.template_repository.full_name // ""',
  ]))
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

// Guarded so a test can `import` this module for its pure helpers (SCOPE,
// TEMPLATE_REPO, parseArgs, expandPackageName, scopedDeps, resolveGitIdentity,
// gitIdentityArgs, resolveOwner, ownerFromRemoteUrl, buildSiteList,
// existingBranchAction) without
// running the CLI — which talks to `gh` and the registry from its very first
// line.
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
