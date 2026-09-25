/**
 * Shared `gh`/`git` plumbing for the operator tools in this repository
 * (`propagate.mjs`, `new-website.mjs`).
 *
 * Extracted from `propagate.mjs`, which was the first tool to need it. Kept
 * here rather than duplicated so the two tools cannot drift apart on how
 * `gh` authentication, the estate's owner, and a disposable container's git
 * identity are resolved — three things every operator tool in this
 * repository needs and none of them should re-derive its own way.
 *
 * Nothing here prints or stores a token. `gh` itself may hold one (in the OS
 * keyring on an operator's own machine, or via `GH_TOKEN` in a container);
 * see the header of `propagate.mjs` and MAINTENANCE.md "Step 3, with the
 * tool" for the container invocation.
 */

import { execFileSync } from 'node:child_process'

export const SCOPE = '@museumwnf'

// The templates a website is created from: a product from `website-template`,
// a gallery or an exhibition from its family's template. A repository of the
// estate's owner whose `template_repository` is one of these is a website.
// package-ci.yml's "Discover websites" lists the same three.
export const SITE_TEMPLATES = ['website-template', 'gallery-template', 'exhibition-template']

// The template `new-website.mjs` creates a product from.
export const TEMPLATE_REPO = 'website-template'

/** Whether `fullName` (a `template_repository`) is one of `owner`'s site templates. */
export function isSiteTemplate(owner, fullName) {
  return SITE_TEMPLATES.some((name) => fullName === `${owner}/${name}`)
}

// ── Shell helpers ──────────────────────────────────────────────────────────

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()
}

export function gh(args, opts = {}) {
  return run('gh', args, opts)
}

// ── gh authentication ────────────────────────────────────────────────────

/**
 * Fail fast, with an actionable message, if `gh` cannot authenticate — and
 * make sure `git push` will use that same authentication.
 *
 * Without this, the first symptom of a missing/unreachable token used to
 * surface deep in a `git push` as a bare credential-helper error ("could not
 * read Username"), after everything before it had already run. `gh auth
 * setup-git` installs `gh` as git's credential helper for its hosts
 * (idempotent — safe to run on every invocation, on the operator's own
 * machine or in a fresh container alike), so a plain `git push` afterwards
 * authenticates the same way `gh pr create` does.
 */
export function ensureGhAuth() {
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

// ── Git commit identity ─────────────────────────────────────────────────

/** Whether `git config` already resolves both `user.name` and `user.email` — a real
 * developer machine, or a container someone configured ahead of time. Config only:
 * GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL are environment overrides that
 * `git config --get` does not see, which is why resolveGitIdentity() below checks them as
 * a separate, higher-precedence step rather than folding them in here. Deliberately not
 * exercised by a unit test — it shells out to `git config` for real — its callers take the
 * result as a plain boolean so the precedence logic they implement can be tested without it. */
export function hasLocalGitIdentity() {
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
 * derive one — so a tool built on this module remains usable in a disposable container
 * that starts with neither (see `propagate.mjs`'s header and MAINTENANCE.md).
 *
 * Precedence, and why:
 *   1. GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL already set in the environment:
 *      git already reads these for every commit, and an operator who exported them on
 *      purpose should win over anything this tool would guess.
 *   2. `git config user.name`/`user.email` already resolve: leave them alone.
 *   3. Otherwise, derive one from the GitHub identity the caller already has to
 *      authenticate — `user`, typically the `gh api user` response fetched once in main()
 *      and reused here. `login` and the numeric `id` give the conventional GitHub no-reply
 *      address, so a commit made through this tool is attributed to whoever ran it rather
 *      than to an anonymous default, which matters because these commits land as PRs
 *      across the estate.
 *
 * Returns `null` when an identity already exists (cases 1–2, nothing to do), or
 * `{ name, email }` derived from the GitHub account (case 3). Throws, once, up front,
 * if none of the above can supply one, rather than letting `git commit` fail with the
 * same opaque error again later.
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

// ── Owner resolution ─────────────────────────────────────────────────────

/**
 * The GitHub owner (user or org) a tool built on this module operates against.
 *
 * This must be a property of the estate — the account that currently owns
 * `website-template` and the sites created from it — never the login of
 * whoever happens to be running the tool. See `propagate.mjs`'s header
 * comment for the full history (this used to be `gh api user`'s login,
 * which already matched nothing for a collaborator whose own account does
 * not own the sites, and matched nothing for *everyone* the day the estate
 * moved from `metanull` to `museumwithnofrontiers`).
 *
 * Precedence:
 *   1. `--owner`, explicit and authoritative.
 *   2. The `origin` remote of the git checkout the tool is running from —
 *      see ownerFromRemoteUrl().
 */
export function resolveOwner(explicitOwner, cwd = process.cwd()) {
  if (explicitOwner) return explicitOwner

  let url
  try {
    url = run('git', ['remote', 'get-url', 'origin'], { cwd })
  } catch (error) {
    throw new Error(
      'Could not determine the GitHub owner to operate on: `git remote get-url origin`\n' +
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
