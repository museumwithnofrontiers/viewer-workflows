# Maintaining the MWNF website platform

One flow, followed unconditionally. Everything below either serves it or is a
rule that keeps it honest.

## Three rules

**1. A credential is never named in a tracked file.**
All eleven platform packages (`viewer-core`, `viewer-layout`, `viewer-i18n`,
every `<dataset>-data` package) publish to the public npmjs registry, and CI
installs them like any other public dependency — no `registry-url`, no
`scope`, no `NODE_AUTH_TOKEN`, nothing for `actions/setup-node` to
authenticate. Publishing itself uses [trusted publishing](https://docs.npmjs.com/trusted-publishers/):
`package-release.yml` exchanges a GitHub Actions OIDC token for a
short-lived npm credential, so no npm token is stored anywhere either. The
propagation tool uses the operator's own `gh` login, and developers who need
to publish by hand authenticate from their own npmjs.com login (`npm login`)
— none of that is a repository secret or a tracked file.

**2. Published packages are `1.x` or higher.**
Under `0.x`, `^0.2.0` admits only `0.2.y`, so a "minor" release falls outside
the declared range: `npm update` silently changes nothing and "minor is
additive" is not true. From `1.0.0` the ranges mean what everyone assumes.
Sites declare `^1.0.0` — never `*`, which is not a constraint at all and leaves
the manifest carrying no intent.

**3. Dependabot does not drive the `@museumwnf` platform packages, by choice.**
Nothing technical stops it — the packages are public on npmjs, so Dependabot
could read them like any other dependency. They stay out of
`dependabot-automerge.yml`'s auto-merge condition and out of the automated
flow deliberately: propagation is the one point in the release flow where a
human decides *when* a new version reaches sites (see "The flow" below), and
that decision runs through `tools/propagate.mjs`, not a Dependabot pull
request.

Dependabot still runs, and matters: it keeps **third-party** dependencies and
**GitHub Actions** current, both of which resolve fine.

## The flow

Identical for `viewer-core`, `viewer-layout`, `viewer-i18n` and every
`<dataset>-data` package. There is no second procedure.

| | Step | Gate |
|---|---|---|
| 1 | Open a PR on the package repository | Its CI builds **every** website against the packed tarball. This is the only cross-site check that exists — nothing downstream repeats it. |
| 2 | Merge, tag `vX.Y.Z`, publish the GitHub Release | `package-release.yml` publishes to npmjs via trusted publishing — see the README's [Publishing to npmjs](README.md#publishing-to-npmjs). Publishing the *Release* is the trigger; merging is not. |
| 3 | **Propagate** | The one human decision: *when*. |
| 4 | One PR per website, each running that site's own CI | Green merges itself. Red stops and waits for a person. |
| 5 | Merge deploys the site | |

Step 4 merging on green is safe *because* step 1 already built that exact
tarball against every site: a green site PR carries no new information. The
operator controls **when** propagation happens; CI controls **whether** it
lands.

### Step 3, with the tool

```bash
export GH_TOKEN=$(gh auth token)
docker run --rm -it \
  -e GH_TOKEN \
  -v "$PWD:/w" \
  -w /w node:lts-alpine sh -c "apk add --no-cache git github-cli >/dev/null && \
    node tools/propagate.mjs --expect viewer-core@1.0.0 --expect viewer-layout@1.0.0"
```

`GH_TOKEN` must be passed explicitly. `gh auth login` on the host commonly
stores the token in the OS keyring (e.g. Windows Credential Manager), which a
container cannot reach — mounting `~/.config/gh` alone carries no usable
token then. `gh auth token` reads the real token regardless of where `gh`
stores it. The tool itself runs `gh auth setup-git` on every invocation, so
once `gh` is authenticated (via `GH_TOKEN` or otherwise), `git push` inherits
the same credentials.

No `~/.npmrc` is mounted: the tool reads package versions off the public
npmjs registry, which needs no credential, and rule 1 above means nothing
else in this container needs one either. Mounting an operator's npm
credentials into a disposable container that nothing in it authenticates
with would be exposure for no benefit.

`-v "$PWD:/w"` must be a checkout of viewer-workflows itself — not an empty
directory — for two reasons: it is where `tools/propagate.mjs` is read from,
and its `origin` remote is where the tool reads the GitHub owner (user or org)
to search for sites under. That owner is deliberately never the operator's
own `gh` login — a collaborator's personal account does not own the sites,
and now that the estate has moved from `metanull` to `museumwithnofrontiers`,
no operator's login does either. Pass `--owner <login-or-org>` to override it
(e.g. running from a checkout whose remote does not point at the estate).

Add `--dry-run` first if you want to see what it would do. `--repo owner/name`
restricts it to one site; `--no-merge` opens the pull requests without enabling
auto-merge.

`--expect` is required on purpose. Run before the publish workflow has
finished and `latest` still resolves to the previous version: the tool would
bump nothing and exit 0, which looks exactly like success. `--expect` turns
that silent no-op into a refusal.

Discovering zero sites is also a hard error, for the same reason: it is what
an operator would see immediately after the org move if they ran the tool
from a stale checkout or without `--owner`, and it must never be
indistinguishable from a real, quiet propagation.

The branch it pushes, `chore/propagate-platform-packages`, belongs to the
tool. A site that does not delete branches on merge keeps that branch after
the pull request lands, and the next propagation finds it in the way. The tool
replaces such a leftover on its own. It only steps back, reporting the site as
`pending`, when a pull request is still **open** on that branch: an earlier
propagation waiting on a person is never overwritten. Merge or close that pull
request, then rerun with `--repo` for that site.

The commit identity comes from `GIT_AUTHOR_*`/`GIT_COMMITTER_*` if you pass
them (`-e GIT_AUTHOR_NAME=…` and so on), otherwise from the container's git
config, otherwise it is derived from the `gh` login. Pass them when the
propagation commits should carry the same identity as your other commits.

### Step 3, by hand

The tool only removes repetition; the procedure stands without it. Per site:

```bash
gh repo clone museumwithnofrontiers/<site> && cd <site>
git checkout -b chore/propagate-platform-packages
npm install @museumwnf/viewer-core@latest @museumwnf/viewer-layout@latest
git commit -am "chore(deps): adopt the published @museumwnf packages"
gh pr create --fill && gh pr merge --auto --squash
```

Use `npm install …@latest`, not `npm update`: update only moves within the
declared range, so it does nothing when a release falls outside it.

## Which websites are consumers

Derived, never listed. A website is a repository created from
`website-template`, and GitHub records that permanently as
`template_repository`. Both `package-ci.yml`'s downstream matrix and
`tools/propagate.mjs` read it, so the set of sites validated before a release
and the set updated after it cannot drift apart.

This replaced a hand-written `dependents.json` kept in both package repos,
which had to be edited in two places for every new site and, until the
`Downstream (all)` fan-in job, also needed a matching branch-protection edit.

**Blind spot, accepted knowingly:** discovery finds repositories *owned by the
template's owner* that still carry the link. A site created by fork or
transferred in from elsewhere is invisible to both. The resolved list and its
count are printed on every CI run and every propagation, so an unexpected drop
is visible; pass such a site explicitly with `--repo`.

The "template's owner" itself must be a property of the estate in both places,
never of whoever is running the check. `package-ci.yml` gets it for free from
`github.repository_owner` — the repository the workflow is already running
in. `tools/propagate.mjs` runs on an operator's machine, which has no
equivalent built in, so it reads it from the `origin` remote of its own
checkout instead (or `--owner`, explicitly) — see `resolveOwner()` and the
"Step 3, with the tool" note above. Discovering zero sites is a hard error in
the tool for exactly this reason: a wrong owner must fail loudly, not report
an empty propagation as a success.

## Releasing viewer-workflows itself

Tags here are **immutable**. Release `vX.Y.Z` and stop; there is no moving
major tag. Consumers pin the exact version and Dependabot's `github-actions`
ecosystem — which is unaffected by rule 3, since it resolves against the GitHub
API rather than the npm registry — brings each repository a pull request that
runs its own CI before adopting the release. `v1` still exists, frozen at
v1.1.2, and nothing should newly reference it.

The reasoning is in the README's Versioning section.
