#!/usr/bin/env node
/**
 * Create and configure a new MWNF website repository from website-template.
 *
 * This is the mechanical part of website-template's README, "Admin —
 * creating a new website" (steps 1, 3–5 and part of step 2/4): create the
 * repository from the template, switch on the settings every live site
 * carries (Pages, the ruleset, classic branch protection, auto-merge,
 * delete-branch-on-merge, CodeQL, Dependabot security updates and
 * vulnerability alerts), then scaffold the first branch (replace the
 * placeholders, install the dataset package, open the first PR).
 *
 * What this deliberately does NOT do — these stay by hand, or are scripted
 * elsewhere, because they are content decisions or depend on inventory-app:
 *   - filling in `dataset.config.js` / `theme/tokens.css` with the site's
 *     actual palette, facets and sheet fields (website-template README,
 *     step 6) — a content decision, not a mechanical one;
 *   - the texts PR (`scripts/site-i18n` extraction into `locales/`);
 *   - the `.new-architecture` submodule pointer and the `dependents.json`
 *     canary entry in inventory-app;
 *   - the inventory-app Dependabot entry for the new site (hand-maintained,
 *     CI-enforced — see the "Dependabot vs GitHub Packages auth" finding).
 * All four are the other steps of the "creating a website" recipe, written
 * up in inventory-app's docs/deployment/new-website.md (story #1921,
 * written in parallel with this tool).
 *
 * Usage:
 *   node tools/new-website.mjs --slug carpets --class gallery --namespace carpets --title "Carpets"
 *   node tools/new-website.mjs --slug carpets --class gallery --namespace carpets --title "Carpets" --dry-run
 *   node tools/new-website.mjs --settings-only --slug carpets
 *   node tools/new-website.mjs --settings-only --dry-run --slug carpets
 *
 * Options:
 *   --slug <slug>          REQUIRED. Kebab-case. Also the repository name
 *                          and the data package's `<slug>-data`.
 *   --class <kind>         gallery | exhibition | standalone. Required
 *                          unless --settings-only.
 *   --namespace <ns>       One lowercase word, no hyphens (carpets,
 *                          waterInIslam) — the name this website's own
 *                          viewer-i18n entries carry. Required unless
 *                          --settings-only.
 *   --title "<name>"       The website's name. Required unless
 *                          --settings-only. Becomes the repo description
 *                          "<name> — a Museum With No Frontiers website".
 *   --owner <login-or-org> The account to create/configure the repository
 *                          under. Defaults to the `origin` remote of this
 *                          checkout, like propagate.mjs — see
 *                          gh-lib.mjs's resolveOwner().
 *   --dry-run              Resolve and report; touch nothing. Every `gh
 *                          api` call this tool makes goes through ghApi()
 *                          (below), which structurally refuses to send a
 *                          non-GET request while --dry-run is set — this is
 *                          not a convention this file has to keep by hand.
 *                          The content phase (branch, placeholders, PR) is
 *                          skipped entirely under --dry-run rather than run
 *                          against a scratch clone, so a dry run never
 *                          shells out to `git push`, `gh pr create` or `gh
 *                          pr merge` either.
 *   --settings-only        Re-apply the settings phase to a repository that
 *                          already exists. Skips the data-package preflight
 *                          and the whole content phase. Idempotent: probes
 *                          first, changes only what is missing, and reports
 *                          "already in place" for the rest.
 *   --no-merge              Open the first pull request without enabling
 *                          auto-merge.
 *
 * Requires: `gh` authenticated as an operator with admin rights on the
 * target org (repository administration is not a permission GITHUB_TOKEN
 * can ever hold — see vuejs-template/scripts/setup-repo.ps1's header),
 * `npm` reachable to the public npmjs registry, and `git`. Same credential
 * rules as propagate.mjs (see gh-lib.mjs and MAINTENANCE.md "Step 3, with
 * the tool"): this tool never reads a token from the environment and never
 * prints one.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  SCOPE,
  TEMPLATE_REPO,
  ensureGhAuth,
  gh,
  gitIdentityArgs,
  hasLocalGitIdentity,
  resolveGitIdentity,
  resolveOwner,
  run,
} from './gh-lib.mjs'

const CLASSES = ['gallery', 'exhibition', 'standalone']
const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const NAMESPACE_RE = /^[a-z][a-zA-Z0-9]*$/
const RULESET_NAME = 'main-requires-pr'
const REQUIRED_CHECKS = [
  'ci / Build (blocking)',
  'ci / Test (blocking)',
  'ci / Texts (blocking)',
  'locales / Validate locale files',
]
const CHECK_APP_ID = 15368 // GitHub Actions
const CONTENT_BRANCH_PREFIX = 'chore/scaffold-'

// ── Arguments ──────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    slug: null,
    class: null,
    namespace: null,
    title: null,
    owner: null,
    dryRun: false,
    settingsOnly: false,
    merge: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--slug') opts.slug = argv[++i]
    else if (arg === '--class') opts.class = argv[++i]
    else if (arg === '--namespace') opts.namespace = argv[++i]
    else if (arg === '--title') opts.title = argv[++i]
    else if (arg === '--owner') opts.owner = argv[++i]
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--settings-only') opts.settingsOnly = true
    else if (arg === '--no-merge') opts.merge = false
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!opts.slug) {
    throw new Error('--slug <slug> is required.')
  }
  if (!SLUG_RE.test(opts.slug)) {
    throw new Error(
      `--slug must be kebab-case (lowercase letters, digits, single hyphens), got "${opts.slug}".`
    )
  }

  if (!opts.settingsOnly) {
    if (!opts.class) {
      throw new Error('--class gallery|exhibition|standalone is required, unless --settings-only.')
    }
    if (!opts.namespace) {
      throw new Error('--namespace <ns> is required, unless --settings-only.')
    }
    if (!opts.title) {
      throw new Error('--title "<name>" is required, unless --settings-only.')
    }
  }

  if (opts.class !== null && !CLASSES.includes(opts.class)) {
    throw new Error(`--class must be one of ${CLASSES.join(', ')}, got "${opts.class}".`)
  }
  if (opts.namespace !== null && !NAMESPACE_RE.test(opts.namespace)) {
    throw new Error(
      '--namespace must be one lowercase word, no hyphens (e.g. carpets, waterInIslam), ' +
      `got "${opts.namespace}".`
    )
  }

  return opts
}

// ── ghApi(): the one choke point for every `gh api` call ───────────────────

/**
 * The method a `gh api` invocation actually sends. `gh api` defaults to GET,
 * *except* it silently switches to POST the moment any field flag (-f/-F/
 * --raw-field/--field) or --input is present without an explicit -X/--method
 * — a documented gh behaviour that is easy to forget when skimming a call
 * for "is this a write". Reading it explicitly here, rather than trusting
 * call sites to always pass -X, is what makes the dry-run guard below a
 * structural property of ghApi() instead of a convention every call site has
 * to remember to keep.
 */
export function ghApiMethod(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-X' || args[i] === '--method') return String(args[i + 1]).toUpperCase()
  }
  const hasFields = args.some((a) => a === '-f' || a === '-F' || a === '--raw-field' || a === '--field' || a === '--input')
  return hasFields ? 'POST' : 'GET'
}

/**
 * Every `gh api` call this tool makes goes through here — never `gh(['api', ...])`
 * directly. That is what makes the hard limit in this story real rather than
 * aspirational: "every `gh` call against a live repo is a GET; the only
 * permitted way to exercise a write path is --dry-run, which must never send
 * a non-GET request". A call site cannot forget to check `dryRun` before a
 * PATCH/POST/PUT/DELETE, because there is no other path to `gh api` in this
 * file for it to use instead.
 *
 * `runner` is injectable so tools/new-website.test.mjs can prove the refusal
 * without a real `gh` on PATH and without a network call — the same
 * dependency-injection shape buildSiteList() in propagate.mjs uses for
 * `getTemplate`.
 */
export function ghApi(args, { dryRun = false, runner = gh } = {}) {
  const method = ghApiMethod(args)
  if (dryRun && method !== 'GET') {
    throw new Error(
      `Refusing to run a non-GET gh api call in --dry-run mode: gh api ${args.join(' ')}\n` +
      'This is ghApi()\'s structural guard, not a call site that forgot --dry-run.'
    )
  }
  return runner(['api', ...args])
}

/** ghApi(), parsed as JSON, or `null` for a 404/failed GET — the common shape
 * every probe below needs ("does this setting exist, and if so what is it"). */
function ghApiJson(args, opts) {
  try {
    return JSON.parse(ghApi(args, opts))
  } catch (error) {
    if (error instanceof SyntaxError) throw error // ghApi() succeeded but returned non-JSON: a real bug.
    return null
  }
}

// ── Reporting ────────────────────────────────────────────────────────────

const LABEL_WIDTH = 18

function report(label, status) {
  console.log(`${label.padEnd(LABEL_WIDTH)}${status}`)
}

// ── Preflights ─────────────────────────────────────────────────────────────

export function preflight(opts, owner) {
  console.log('Preflights')

  ensureGhAuth()
  report('[gh auth]', 'authenticated')

  const templateFullName = `${owner}/${TEMPLATE_REPO}`
  const template = ghApiJson([`repos/${templateFullName}`, '--jq', '{full_name}'], { dryRun: opts.dryRun })
  if (!template) {
    throw new Error(`${templateFullName} does not exist or is not reachable — cannot create from a missing template.`)
  }
  report('[Template]', `${templateFullName} exists`)

  if (!opts.settingsOnly) {
    const pkg = `${SCOPE}/${opts.slug}-data`
    try {
      run('npm', ['view', pkg, 'version'])
    } catch {
      throw new Error(
        `${pkg} is not on the npmjs registry yet.\n` +
        '  · The dataset package must be published before a website can be scaffolded from it —\n' +
        '    see the exporter/publish story for this dataset.\n' +
        '  · Pass --settings-only to configure an existing repository without installing a dataset.'
      )
    }
    report('[Data package]', `${pkg} is on the registry`)
  }
}

// ── Repository creation ─────────────────────────────────────────────────

/** Whether `repoInfo` (a `gh api repos/{r}` response, or `null` on a 404) means the
 * repository already exists — the first of this phase's "already in place" decisions. */
export function repoExists(repoInfo) {
  return Boolean(repoInfo)
}

export function ensureRepository(opts, owner) {
  console.log('\nRepository')
  const fullName = `${owner}/${opts.slug}`
  const existing = ghApiJson([`repos/${fullName}`, '--jq', '{full_name,template_repository:.template_repository.full_name}'], {
    dryRun: opts.dryRun,
  })

  if (repoExists(existing)) {
    if (existing.template_repository !== `${owner}/${TEMPLATE_REPO}`) {
      throw new Error(
        `${fullName} already exists but was not created from ${owner}/${TEMPLATE_REPO} ` +
        `(template_repository is "${existing.template_repository || 'none'}"). ` +
        'Refusing to configure a repository this tool did not create from the template — ' +
        'propagate.mjs and package-ci.yml discovery both rely on that link.'
      )
    }
    report('[Repository]', 'already exists, created from the template')
    return { fullName, created: false }
  }

  if (opts.settingsOnly) {
    throw new Error(`--settings-only was given but ${fullName} does not exist.`)
  }

  if (opts.dryRun) {
    report('[Repository]', `would create ${fullName} from ${owner}/${TEMPLATE_REPO} (public)`)
    return { fullName, created: false, wouldCreate: true }
  }

  gh([
    'repo', 'create', fullName,
    '--template', `${owner}/${TEMPLATE_REPO}`,
    '--public',
    '--description', `${opts.title} — a Museum With No Frontiers website`,
  ])

  const created = ghApiJson([`repos/${fullName}`, '--jq', '{full_name,template_repository:.template_repository.full_name}'], {})
  if (!created || created.template_repository !== `${owner}/${TEMPLATE_REPO}`) {
    throw new Error(
      `${fullName} was created but does not carry template_repository = "${owner}/${TEMPLATE_REPO}" ` +
      `(got "${created?.template_repository || 'none'}"). ` +
      'propagate.mjs and package-ci.yml discover websites from this link; without it, this site ' +
      'is invisible to both.'
    )
  }
  report('[Repository]', `created from ${owner}/${TEMPLATE_REPO}`)
  return { fullName, created: true }
}

// ── Settings: Pages ─────────────────────────────────────────────────────

/** Whether Pages needs (re-)enabling with `build_type: workflow` — `pages` is a
 * `gh api repos/{r}/pages` response, or `null` when Pages is not enabled at all. */
export function pagesNeedsChange(pages) {
  return pages?.build_type !== 'workflow'
}

function ensurePages(fullName, dryRun) {
  const pages = ghApiJson([`repos/${fullName}/pages`, '--jq', '{build_type}'], { dryRun })
  if (!pagesNeedsChange(pages)) {
    report('[Pages]', 'already in place')
    return
  }
  if (dryRun) {
    report('[Pages]', pages ? 'would set build_type=workflow' : 'would enable (build_type=workflow)')
    return
  }
  if (pages) {
    ghApi([`repos/${fullName}/pages`, '-X', 'PUT', '-f', 'build_type=workflow'], {})
  } else {
    ghApi([`repos/${fullName}/pages`, '-X', 'POST', '-f', 'build_type=workflow'], {})
  }
  report('[Pages]', 'enabled (build_type=workflow)')
}

// ── Settings: ruleset ────────────────────────────────────────────────────

/** The `main-requires-pr` ruleset payload, mirroring every live site (confirmed against
 * museumwithnofrontiers/carpets and museumwithnofrontiers/water-in-islam, 2026-09-21). */
export function canonicalRuleset() {
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
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
  }
}

/** The fields this tool controls, picked out of a full ruleset object — a full
 * `gh api repos/{r}/rulesets/{id}` response, or the canonical payload above. Picking a
 * known set rather than stripping the read-only fields (id, node_id, _links, created_at,
 * updated_at, source, source_type, current_user_can_bypass, bypass_actors) is equivalent
 * and does not have to be kept in sync with whatever new read-only field GitHub adds next. */
function pickRulesetFields(ruleset) {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    rules: ruleset.rules,
  }
}

/** A JSON.stringify with object keys sorted at every level, so two objects that are
 * deep-equal but were built (or served by the GitHub API) with keys in a different order
 * compare equal. `gh api repos/{r}/rulesets/{id}` serves `conditions.ref_name` as
 * `{exclude, include}`; canonicalRuleset() above writes it `{include, exclude}` — both
 * correct, and a plain JSON.stringify diff would call that a mismatch forever. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function rulesetNeedsChange(existing, canonical = canonicalRuleset()) {
  if (!existing) return true
  return stableStringify(pickRulesetFields(existing)) !== stableStringify(pickRulesetFields(canonical))
}

function ensureRuleset(fullName, dryRun) {
  const rulesets = ghApiJson([`repos/${fullName}/rulesets`], { dryRun }) || []
  const existingSummary = rulesets.find((r) => r.name === RULESET_NAME)
  const existing = existingSummary
    ? ghApiJson([`repos/${fullName}/rulesets/${existingSummary.id}`], { dryRun })
    : null

  if (!rulesetNeedsChange(existing)) {
    report('[Ruleset]', 'already in place')
    return
  }

  if (dryRun) {
    report('[Ruleset]', existing ? 'would update main-requires-pr' : 'would create main-requires-pr')
    return
  }

  const payloadFile = join(tmpdir(), `new-website-ruleset-${process.pid}.json`)
  writeFileSync(payloadFile, JSON.stringify(canonicalRuleset()))
  try {
    if (existing) {
      ghApi([`repos/${fullName}/rulesets/${existing.id}`, '-X', 'PUT', '--input', payloadFile], {})
      report('[Ruleset]', 'updated main-requires-pr')
    } else {
      ghApi([`repos/${fullName}/rulesets`, '-X', 'POST', '--input', payloadFile], {})
      report('[Ruleset]', 'created main-requires-pr')
    }
  } finally {
    rmSync(payloadFile, { force: true })
  }
}

// ── Settings: classic branch protection ─────────────────────────────────

/** The classic `branches/main/protection` PUT payload, mirroring every live site
 * (confirmed against carpets and water-in-islam, 2026-09-21). A PUT to this endpoint
 * requires required_status_checks, enforce_admins, required_pull_request_reviews and
 * restrictions all present — null where the site has none of the latter two. */
export function canonicalProtection() {
  return {
    required_status_checks: {
      strict: false,
      checks: REQUIRED_CHECKS.map((context) => ({ context, app_id: CHECK_APP_ID })),
    },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: false,
    lock_branch: false,
    allow_fork_syncing: false,
  }
}

function normalizeChecks(checks) {
  return [...checks]
    .map((c) => ({ context: c.context, app_id: c.app_id ?? null }))
    .sort((a, b) => a.context.localeCompare(b.context))
}

/** `existing` is a GET `branches/main/protection` response (nested `{enabled}` booleans,
 * or absent fields when a rule is off) or `null` when there is no protection at all;
 * `canonical` is the flat PUT-shaped payload above — GitHub's GET and PUT shapes for this
 * endpoint differ, which is why this compares field by field instead of a blind
 * JSON.stringify diff. */
export function protectionNeedsChange(existing, canonical = canonicalProtection()) {
  if (!existing) return true

  const existingChecks = normalizeChecks(existing.required_status_checks?.checks ?? [])
  const canonicalChecks = normalizeChecks(canonical.required_status_checks.checks)
  if (JSON.stringify(existingChecks) !== JSON.stringify(canonicalChecks)) return true
  if ((existing.required_status_checks?.strict ?? null) !== canonical.required_status_checks.strict) return true
  if (Boolean(existing.enforce_admins?.enabled) !== canonical.enforce_admins) return true
  if (Boolean(existing.required_linear_history?.enabled) !== canonical.required_linear_history) return true
  if (Boolean(existing.allow_force_pushes?.enabled) !== canonical.allow_force_pushes) return true
  if (Boolean(existing.allow_deletions?.enabled) !== canonical.allow_deletions) return true
  if (Boolean(existing.block_creations?.enabled) !== canonical.block_creations) return true
  if (Boolean(existing.required_conversation_resolution?.enabled) !== canonical.required_conversation_resolution) return true
  if (Boolean(existing.lock_branch?.enabled) !== canonical.lock_branch) return true
  if (Boolean(existing.allow_fork_syncing?.enabled) !== canonical.allow_fork_syncing) return true
  if (Boolean(existing.required_pull_request_reviews) !== Boolean(canonical.required_pull_request_reviews)) return true
  if (Boolean(existing.restrictions) !== Boolean(canonical.restrictions)) return true

  return false
}

function ensureProtection(fullName, dryRun) {
  const existing = ghApiJson([`repos/${fullName}/branches/main/protection`], { dryRun })

  if (!protectionNeedsChange(existing)) {
    report('[Protection]', 'already in place')
    return
  }

  if (dryRun) {
    report('[Protection]', existing ? 'would update classic branch protection' : 'would enable classic branch protection')
    return
  }

  const payloadFile = join(tmpdir(), `new-website-protection-${process.pid}.json`)
  writeFileSync(payloadFile, JSON.stringify(canonicalProtection()))
  try {
    ghApi([`repos/${fullName}/branches/main/protection`, '-X', 'PUT', '--input', payloadFile], {})
  } finally {
    rmSync(payloadFile, { force: true })
  }
  report('[Protection]', existing ? 'updated classic branch protection' : 'enabled classic branch protection')
}

// ── Settings: repo flags (auto-merge, delete-branch-on-merge) ──────────────

export function repoFlagsNeedChange(repoInfo) {
  return !(repoInfo && repoInfo.allow_auto_merge && repoInfo.delete_branch_on_merge)
}

function ensureRepoFlags(fullName, dryRun) {
  const info = ghApiJson([`repos/${fullName}`, '--jq', '{allow_auto_merge,delete_branch_on_merge}'], { dryRun })

  if (!repoFlagsNeedChange(info)) {
    report('[Repo flags]', 'already in place')
    return
  }
  if (dryRun) {
    report('[Repo flags]', 'would enable allow_auto_merge and delete_branch_on_merge')
    return
  }
  ghApi([`repos/${fullName}`, '-X', 'PATCH', '-f', 'allow_auto_merge=true', '-F', 'delete_branch_on_merge=true'], {})
  report('[Repo flags]', 'enabled allow_auto_merge and delete_branch_on_merge')
}

// ── Settings: security (automated fixes, vulnerability alerts, CodeQL) ────

/** `info` is a `gh api repos/{r}/automated-security-fixes` response, or `null`. */
export function securityFixesNeedChange(info) {
  return !info?.enabled
}

function ensureSecurityFixes(fullName, dryRun) {
  const info = ghApiJson([`repos/${fullName}/automated-security-fixes`], { dryRun })
  if (!securityFixesNeedChange(info)) {
    report('[Security fixes]', 'already in place')
    return
  }
  if (dryRun) {
    report('[Security fixes]', 'would enable Dependabot automated security fixes')
    return
  }
  ghApi([`repos/${fullName}/automated-security-fixes`, '-X', 'PUT'], {})
  report('[Security fixes]', 'enabled Dependabot automated security fixes')
}

function ensureVulnerabilityAlerts(fullName, dryRun) {
  // Vulnerability alerts have no JSON body: 204 means on, 404 means off — ghApi() returns
  // the (empty) response text on 204 and gh itself throws on 404.
  let enabled = true
  try {
    ghApi([`repos/${fullName}/vulnerability-alerts`], { dryRun })
  } catch {
    enabled = false
  }
  if (enabled) {
    report('[Vuln alerts]', 'already in place')
    return
  }
  if (dryRun) {
    report('[Vuln alerts]', 'would enable vulnerability alerts')
    return
  }
  ghApi([`repos/${fullName}/vulnerability-alerts`, '-X', 'PUT'], {})
  report('[Vuln alerts]', 'enabled vulnerability alerts')
}

/** `setup` is a `gh api repos/{r}/code-scanning/default-setup` response, or `null`. */
export function codeScanningNeedsChange(setup) {
  return setup?.state !== 'configured'
}

function ensureCodeScanning(fullName, dryRun) {
  const setup = ghApiJson([`repos/${fullName}/code-scanning/default-setup`], { dryRun })
  if (!codeScanningNeedsChange(setup)) {
    report('[CodeQL]', 'already in place')
    return
  }
  if (dryRun) {
    report('[CodeQL]', 'would configure the CodeQL default setup')
    return
  }

  // The org auto-enables CodeQL default setup on a freshly created repo, which can race
  // this PATCH and answer 409 while that is in flight — known from vuejs-template's
  // setup-repo.ps1. Treat 409 as "already being configured", not a failure: re-read after
  // a short wait and report whatever state that finds, rather than aborting the run over a
  // race this tool did not cause.
  try {
    ghApi([`repos/${fullName}/code-scanning/default-setup`, '-X', 'PATCH', '-f', 'state=configured'], {})
    report('[CodeQL]', 'configured the CodeQL default setup')
  } catch (error) {
    if (!String(error.stderr || error.message).includes('409')) throw error
    execFileSync('node', ['-e', 'setTimeout(()=>{}, 3000)']) // small, dependency-free wait
    const after = ghApiJson([`repos/${fullName}/code-scanning/default-setup`], {})
    report('[CodeQL]', `PATCH returned 409 (org default setup was already configuring this repo) — now: ${after?.state ?? 'unknown'}`)
  }
}

// ── Settings phase ───────────────────────────────────────────────────────

function ensureSettings(fullName, opts) {
  console.log('\nSettings')
  ensurePages(fullName, opts.dryRun)
  ensureRuleset(fullName, opts.dryRun)
  ensureProtection(fullName, opts.dryRun)
  ensureRepoFlags(fullName, opts.dryRun)
  ensureSecurityFixes(fullName, opts.dryRun)
  ensureVulnerabilityAlerts(fullName, opts.dryRun)
  ensureCodeScanning(fullName, opts.dryRun)
}

// ── Content phase: placeholders ─────────────────────────────────────────

/** Pulls the static `CONFIGURED_FILES` array out of the template's own
 * `scripts/check-placeholders.js` source. A regex over the literal, not an `import()` of
 * the file: that script's whole job is to `process.exit(1)` on an unconfigured template
 * (the exact state of every fresh scaffold clone, before this tool has replaced anything),
 * and running it for real inside this process's own event loop would take this tool down
 * with it. The list stays the template's own, not a copy this tool could drift from — see
 * the file's own header, "the list is the one README step 2 hands the admin". */
export function parseConfiguredFiles(source) {
  const match = source.match(/CONFIGURED_FILES\s*=\s*\[([\s\S]*?)\]/)
  if (!match) throw new Error('Could not find CONFIGURED_FILES in check-placeholders.js.')
  const files = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  if (!files.length) throw new Error('CONFIGURED_FILES in check-placeholders.js parsed to an empty list.')
  return files
}

/** The name placeholder (`NAME_PLACEHOLDER`, `__DATASET__` today) — parsed rather than
 * hardcoded for the same reason as parseConfiguredFiles(): the template stays authoritative. */
export function parseNamePlaceholder(source) {
  const match = source.match(/NAME_PLACEHOLDER\s*=\s*['"]([^'"]+)['"]/)
  if (!match) throw new Error('Could not find NAME_PLACEHOLDER in check-placeholders.js.')
  return match[1]
}

/** The text placeholders (`TEXT_PLACEHOLDERS`'s keys, `__SITE_CLASS__`/`__SITE_NAMESPACE__`
 * today) — parsed for the same reason. */
export function parseTextPlaceholders(source) {
  const match = source.match(/TEXT_PLACEHOLDERS\s*=\s*\{([\s\S]*?)\n\}/)
  if (!match) throw new Error('Could not find TEXT_PLACEHOLDERS in check-placeholders.js.')
  const keys = [...match[1].matchAll(/^\s*(__[A-Z_]+__)\s*:/gm)].map((m) => m[1])
  if (!keys.length) throw new Error('TEXT_PLACEHOLDERS in check-placeholders.js parsed to an empty list.')
  return keys
}

/**
 * Builds the `{ placeholder: value }` replacement map for one scaffold, from the
 * template's own check-placeholders.js source and this tool's CLI options.
 *
 * Throws if check-placeholders.js declares a text placeholder this tool does not know how
 * to fill (only `__SITE_CLASS__`/`__SITE_NAMESPACE__` are known) — a template that grows a
 * new placeholder must fail this tool loudly rather than scaffold a site that still
 * carries it, silently reproducing the exact bug the preinstall guard exists to catch.
 */
export function buildReplacements(source, opts) {
  const namePlaceholder = parseNamePlaceholder(source)
  const textPlaceholders = parseTextPlaceholders(source)
  const known = { __SITE_CLASS__: opts.class, __SITE_NAMESPACE__: opts.namespace }

  const unknown = textPlaceholders.filter((p) => !(p in known))
  if (unknown.length) {
    throw new Error(
      `check-placeholders.js declares placeholder(s) this tool does not know how to fill: ` +
      `${unknown.join(', ')}. Update buildReplacements() in tools/new-website.mjs.`
    )
  }

  const replacements = { [namePlaceholder]: opts.slug }
  for (const placeholder of textPlaceholders) replacements[placeholder] = known[placeholder]
  return replacements
}

/** Replaces every placeholder in `text` with its mapped value — a plain, ordered
 * string.split/join per entry, not a single regex: placeholder tokens (`__DATASET__`
 * etc.) contain no regex metacharacters, so this stays simple and exact. */
export function applyReplacements(text, replacements) {
  let out = text
  for (const [placeholder, value] of Object.entries(replacements)) {
    out = out.split(placeholder).join(value)
  }
  return out
}

// ── Content phase ────────────────────────────────────────────────────────

function scaffoldContent(fullName, opts, identityArgs) {
  console.log('\nContent')

  if (opts.settingsOnly) {
    report('[Content]', 'skipped (--settings-only)')
    return
  }
  if (opts.dryRun) {
    report(
      '[Content]',
      `would branch ${CONTENT_BRANCH_PREFIX}${opts.slug}, replace placeholders, install ` +
      `${SCOPE}/${opts.slug}-data@latest, and open a PR (skipped in --dry-run)`
    )
    return
  }

  const work = mkdtempSync(join(tmpdir(), 'new-website-'))
  const branch = `${CONTENT_BRANCH_PREFIX}${opts.slug}`
  try {
    gh(['repo', 'clone', fullName, work], { stdio: 'pipe' })
    run('git', ['checkout', '-b', branch], { cwd: work, stdio: 'pipe' })

    const checkPlaceholdersPath = join(work, 'scripts', 'check-placeholders.js')
    const checkPlaceholdersSource = readFileSync(checkPlaceholdersPath, 'utf8')
    const files = parseConfiguredFiles(checkPlaceholdersSource)
    const replacements = buildReplacements(checkPlaceholdersSource, opts)

    let changedFiles = 0
    for (const file of files) {
      const path = join(work, file)
      const before = readFileSync(path, 'utf8')
      const after = applyReplacements(before, replacements)
      if (after !== before) {
        writeFileSync(path, after)
        changedFiles++
      }
    }
    report('[Placeholders]', `replaced in ${changedFiles} of ${files.length} configured files`)

    // Also runs check-placeholders.js as `preinstall` — the intended safety net: a
    // placeholder this tool missed fails the install right here, not silently in CI.
    run('npm', ['install', `${SCOPE}/${opts.slug}-data@latest`], { cwd: work, stdio: 'pipe' })
    report('[Dataset]', `installed ${SCOPE}/${opts.slug}-data@latest`)

    run('git', ['add', '-A'], { cwd: work, stdio: 'pipe' })
    const messageFile = join(tmpdir(), `new-website-message-${process.pid}`)
    writeFileSync(
      messageFile,
      `chore: scaffold ${opts.slug} from website-template\n\n` +
      `Replaces the __DATASET__/__SITE_CLASS__/__SITE_NAMESPACE__ placeholders and installs\n` +
      `${SCOPE}/${opts.slug}-data@latest.\n\n` +
      'Opened by tools/new-website.mjs in museumwithnofrontiers/viewer-workflows.\n'
    )
    run('git', [...identityArgs, 'commit', '-F', messageFile], { cwd: work, stdio: 'pipe' })
    run('git', ['push', '-u', 'origin', branch], { cwd: work, stdio: 'pipe' })

    const prUrl = gh(['pr', 'create', '--repo', fullName, '--head', branch, '--fill'], { cwd: work })
    report('[Pull request]', prUrl)

    if (opts.merge) {
      gh(['pr', 'merge', prUrl, '--repo', fullName, '--auto', '--squash'], { cwd: work })
      report('[Auto-merge]', 'armed')
    } else {
      report('[Auto-merge]', 'skipped (--no-merge)')
    }

    return { prUrl }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

// Guarded so a test can `import` this module for its pure/injectable helpers
// (parseArgs, ghApiMethod, ghApi, repoExists, canonicalRuleset, stableStringify,
// rulesetNeedsChange, canonicalProtection, protectionNeedsChange,
// repoFlagsNeedChange, pagesNeedsChange, securityFixesNeedChange,
// codeScanningNeedsChange, parseConfiguredFiles, parseNamePlaceholder,
// parseTextPlaceholders, buildReplacements, applyReplacements) without
// running the CLI — which talks to `gh`, `npm` and the registry from its
// very first line.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  const owner = resolveOwner(opts.owner)

  console.log(`Target: ${owner}/${opts.slug}${opts.dryRun ? ' (dry run)' : ''}`)

  preflight(opts, owner)
  const { fullName } = ensureRepository(opts, owner)
  ensureSettings(fullName, opts)

  let identityArgs = []
  if (!opts.settingsOnly && !opts.dryRun) {
    const user = JSON.parse(gh(['api', 'user']))
    const identity = resolveGitIdentity(user, process.env, hasLocalGitIdentity())
    identityArgs = gitIdentityArgs(identity)
  }
  const content = scaffoldContent(fullName, opts, identityArgs)

  console.log('\nSummary')
  report('[Repository]', `https://github.com/${fullName}`)
  if (content?.prUrl) report('[Pull request]', content.prUrl)
  if (!opts.settingsOnly && !opts.dryRun) {
    console.log(
      '\nNext (not scripted here): the texts PR, the catalogue/sheet/theme,\n' +
      'the .new-architecture/<slug> submodule in inventory-app, and the\n' +
      'discovery dry-run — see inventory-app docs/deployment/new-website.md.'
    )
  }
}
