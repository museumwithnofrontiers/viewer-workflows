# viewer-workflows

Reusable GitHub Actions workflows for the MWNF Website Platform. Reference them by an exact version — `museumwithnofrontiers/viewer-workflows/.github/workflows/<file>@vX.Y.Z`, replacing `vX.Y.Z` with the [latest release tag](https://github.com/museumwithnofrontiers/viewer-workflows/tags). Tags here are immutable; see [Versioning](#versioning). Platform maintenance procedure: [MAINTENANCE.md](MAINTENANCE.md).

| Workflow | For | Purpose | Inputs | Repo prerequisites |
|---|---|---|---|---|
| `website-ci.yml` | website repos | PR checks: build + test + texts (blocking), ESLint + npm audit (reported only) | — | npm scripts `build`, `test`, `lint`; `@museumwnf/viewer-i18n` installed |
| `website-deploy-pages.yml` | website repos | Build with `BASE_PATH` and deploy `dist/` to GitHub Pages; preflights that Pages is enabled with source "GitHub Actions" and fails with a readable message instead of a 404 stack trace if not | `base_path` (optional, default `/<repo-name>/`) | Pages source set to "GitHub Actions" |
| `locale-validate.yml` | website repos, `viewer-i18n` | Validate the repository's texts with the rules published by [`museumwithnofrontiers/viewer-i18n`](https://github.com/museumwithnofrontiers/viewer-i18n); auto-merge text-only PRs when green; plain-language PR comment on failure | `mode` (`site` \| `dictionary`, default `site`), `texts_path` (default `locales/`), `dictionary_ref` (default `main`) — output: `locales_only` | "Allow auto-merge" enabled |
| `dependabot-automerge.yml` | all repos | Auto-merge Dependabot minor/patch bumps of the reusable workflows and dev-dependency patches; majors wait for a human. The `@museumwnf` platform packages are not covered — their rollout is propagated by the operator instead; see [MAINTENANCE.md](MAINTENANCE.md) | — | "Allow auto-merge" enabled |
| `audit-scheduled.yml` | all repos | Scheduled `npm audit`; opens or updates the issue "npm audit findings"; skips with a notice instead of failing when the repo has no lockfile yet (before its first pull request) | — | — |
| `package-ci.yml` | package repos | PR checks: unit tests, `npm pack`, downstream build matrix over every website, using the PR's tarball. If the PR renames `package.json`'s `name`, the tarball is additionally alias-installed under the pre-rename name in every downstream build, so sites still importing the old name are actually tested against this PR's code instead of silently passing against the last published version | — | — (websites are discovered from the `website-template` link) |
| `package-release.yml` | package repos | `npm publish` to npmjs via trusted publishing, version taken from the release tag | `publish_mode` (`direct` \| `staged`, default `direct`) | A trusted publisher configured on npmjs.com for this repo + the *calling* workflow's filename (no secret) — see [Publishing to npmjs](#publishing-to-npmjs) |

## Operator tools

Two scripts under `tools/`, run by an operator from their own machine (never in CI), sharing
the `gh`/git plumbing in `tools/gh-lib.mjs`. Full usage and the container invocation for
each: [MAINTENANCE.md](MAINTENANCE.md).

| Tool | Does |
|---|---|
| `tools/propagate.mjs` | Step 3 of [the release flow](MAINTENANCE.md#the-flow): rolls a newly published `@museumwnf` package out to every website, one pull request per site. |
| `tools/new-website.mjs` | [Creating a website](MAINTENANCE.md#creating-a-website): creates a repository from `website-template`, applies the settings every live site carries (Pages, ruleset, branch protection, CodeQL, …), and opens the first scaffold pull request. |

## Package installs

No workflow takes a secret, and no PAT is ever stored (since v1.1.2; the
`PACKAGES_READ_TOKEN` secret of earlier releases is gone). All eleven
platform packages (`viewer-core`, `viewer-layout`, `viewer-i18n`, every
`<dataset>-data` package) are public on npmjs, so CI installs them like any
other public dependency — plain `actions/setup-node` plus `npm ci`, no
`registry-url`, no `scope`, no auth token of any kind. Local development
needs nothing special either, for the same reason.

## Publishing to npmjs

`package-release.yml` publishes to `registry.npmjs.org` using
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) — OIDC,
not a stored secret. **No `NPM_TOKEN` or any other npm token is read by this
workflow.** That's deliberate, not a stopgap: the only npm access token a
repository secret can safely hold without a human's own 2FA at publish time
is a ["stage-only"](https://docs.npmjs.com/about-access-tokens/) one, and a
stage-only token cannot run `npm publish` — it can only stage a version for
a maintainer to promote by hand. Trusted publishing is the CI-native
replacement: a short-lived, workflow-scoped credential minted per run, with
provenance attached automatically.

### One-time setup per package repo (on npmjs.com)

1. **The package must already exist on the registry.** Trusted publishing
   cannot create a brand-new package — publish the first version by hand
   from a machine where a maintainer is logged in with 2FA
   (`npm publish --access public`), *then* continue below. (This applies to
   every `@museumwnf/*` package the first time it publishes under that
   scope — see `metanull/inventory-app#1721`.)
2. On the package's Settings → Trusted Publisher, add a GitHub Actions
   publisher:
   - **Organization or user**: the repo owner, `museumwithnofrontiers` (moved
     from the personal account `metanull` in the M2 org move; every trusted
     publisher had to be re-pointed at the org when that move happened, since
     the binding is to the exact owner name).
   - **Repository**: the package repo (e.g. `viewer-core`).
   - **Workflow filename**: the filename of the **calling** workflow in
     that repo — `release.yml` in the snippet below — **not**
     `package-release.yml`. npm authorizes whichever workflow file
     requested the OIDC token, which is always the caller when a reusable
     workflow is involved; entering the reusable workflow's filename here
     is a documented, silent-failure footgun.
   - **Environment**: leave unset unless the repo uses a GitHub environment
     for release protection rules.
   - **Allowed actions**: `npm publish` for the default `publish_mode:
     direct`, or `npm stage publish` if you want every CI-triggered release
     to land in staging for a maintainer's `npm stage approve` (2FA)
     instead — pass `publish_mode: staged` to match.
3. Both the caller (`release.yml`) and this reusable workflow must grant
   `id-token: write` — a reusable workflow's permissions are capped by what
   the caller grants, so the caller declaring it is not optional (see the
   snippet below).

Provenance (`--provenance` for `direct`, also passed for `staged`) needs
`id-token: write`, which this workflow already requests, and a public
repository — true for every package repo here; with trusted publishing, npm
attaches provenance automatically even without the flag, but passing it
explicitly costs nothing and documents intent.

## Caller snippets

### `.github/workflows/ci.yml` (website repos)

```yaml
name: CI
on:
  pull_request:
permissions:
  contents: write
  pull-requests: write
jobs:
  ci:
    uses: museumwithnofrontiers/viewer-workflows/.github/workflows/website-ci.yml@vX.Y.Z
  locales:
    uses: museumwithnofrontiers/viewer-workflows/.github/workflows/locale-validate.yml@vX.Y.Z
```

### `.github/workflows/deploy.yml` (website repos)

```yaml
name: Deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    uses: museumwithnofrontiers/viewer-workflows/.github/workflows/website-deploy-pages.yml@vX.Y.Z
```

### `.github/workflows/automerge.yml` (all repos)

```yaml
name: Dependabot auto-merge
on:
  pull_request:
permissions:
  contents: write
  pull-requests: write
jobs:
  automerge:
    uses: museumwithnofrontiers/viewer-workflows/.github/workflows/dependabot-automerge.yml@vX.Y.Z
```

### `.github/workflows/audit.yml` (all repos)

```yaml
name: Scheduled audit
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
permissions:
  contents: read
  issues: write
jobs:
  audit:
    uses: museumwithnofrontiers/viewer-workflows/.github/workflows/audit-scheduled.yml@vX.Y.Z
```

### `.github/workflows/ci.yml` (package repos)

```yaml
name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  ci:
    uses: museumwithnofrontiers/viewer-workflows/.github/workflows/package-ci.yml@vX.Y.Z
```

### `.github/workflows/release.yml` (package repos)

Publishes to npmjs via trusted publishing — no secret to forward, but the
trusted publisher on npmjs.com must already be configured for *this exact*
`release.yml` filename in *this* repo (see the one-time setup above):

```yaml
name: Release
on:
  release:
    types: [published]
permissions:
  contents: read
  id-token: write
jobs:
  release:
    uses: museumwithnofrontiers/viewer-workflows/.github/workflows/package-release.yml@vX.Y.Z
```

## Versioning

**Tags are immutable. Nothing is ever force-moved.**

- Release `vX.Y.Z` and stop. There is no moving major tag to update.
- Consumers pin the exact version:
  `uses: museumwithnofrontiers/viewer-workflows/.github/workflows/website-ci.yml@vX.Y.Z`
- Every consumer declares the `github-actions` Dependabot ecosystem, so a new
  release arrives there as a pull request. Dependabot covers
  [reusable-workflow refs](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot),
  not just step-level actions.

To release: tag `vX.Y.Z` on `main`, push the tag, done. Dependabot does the rest
on its weekly run; to propagate immediately, use **Insights → Dependency graph →
Dependabot → Check for updates** on the consumers.

### Why not a moving `v1`

A floating major tag is GitHub's normal convention for actions, and this repo
used one until v1.2.0. It fits this platform badly:

- **It ships unverified CI to every repo at once.** `package-ci.yml` builds
  every website against a packed tarball before a *package*
  change can merge — but a *workflow* change had no equivalent check, and a
  broken workflow breaks all ten repos rather than one package's consumers.
  Pinning exactly means each repo runs its own CI, including the full
  `Downstream` matrix, before it adopts a release.
- **A force-moved tag has no audit trail.** Nothing records what `v1` pointed at
  last week or when a given repo started using it. With exact pins, `git log`
  answers both, and a rollback is reverting one pull request in one repo instead
  of another force-push under pressure.

The cost is one pull request per consumer per release instead of none.
`dependabot-automerge.yml` absorbs that: minor and patch bumps merge themselves
once CI is green, and majors wait for a human.

`v1` still exists, frozen at v1.1.2. It is deliberately not deleted — anything
still pointing at it keeps working — but nothing should newly reference it.
