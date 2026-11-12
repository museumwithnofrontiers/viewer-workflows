# Sweeps

One module per change applied to the websites' own files with
`tools/sweep.mjs` (MAINTENANCE.md, "Changing every site's own files: the
sweep"). A module stays here after its run: it is the record of what every
site was changed by, and why.

Name it `<yyyy-mm>-<what>.mjs`. It exports:

```js
export const branch = 'chore/sweep-<what>'   // its own branch, never another tool's
export const title = 'Adopt …'               // commit and pull request title
export const body = `Why, in a few lines.`   // pull request description
export const families = ['gallery-template'] // optional: the templates whose sites it concerns

export async function apply({ dir, repo, name, template, install }) {
  // Edit files under `dir` with node:fs. `install('@museumwnf/viewer-layout@^3.71.0')`
  // runs npm install in the clone. Return a string to skip the site with that reason.
}
```

Keep a change mechanical and checkable. Read the file a site has, and refuse
(return a reason) when it is not the shape the change expects, instead of
rewriting it anyway: a site that diverged on purpose is the operator's to
look at, not the sweep's to flatten.
