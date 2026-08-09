# Releasing

Maintainer notes. Not shipped in the tarball — [`SECURITY.md`](SECURITY.md) is
the outward-facing statement of how releases work and what a consumer can
verify; this file is the procedure, and what has actually gone wrong running it.

Publishing is tag-driven and runs entirely in
[`.github/workflows/release.yml`](.github/workflows/release.yml). There is no
npm token anywhere: the workflow exchanges an OIDC token for publish rights
through the `npm-publish` environment. That is also why a release cannot be
rolled back — the token is scoped to `npm publish` and cannot move a dist-tag.

## The procedure

1. **Bump the version on a branch.**

   ```sh
   git switch -c release-0.5.0
   npm version minor --no-git-tag-version
   ```

   `--no-git-tag-version` matters: without it npm creates the tag *here*, on a
   commit that is not yet on `main`, and `preflight` rejects it.

   Then date the section in [`CHANGELOG.md`](CHANGELOG.md) — `## Unreleased`
   becomes `## 0.5.0 — YYYY-MM-DD`, no `v` prefix.

2. **Open a pull request and merge it.** The branch ruleset requires
   `ci-required`, which waits on every gating job in `ci.yml`.

3. **Wait for CI to pass on `main` itself.** Merging produces a *new* commit,
   and `preflight` polls for a successful `ci.yml` run against that exact SHA.
   Tagging before it finishes is not fatal — preflight waits up to 30 minutes —
   but a red CI means a wasted tag.

4. **Tag and push.**

   ```sh
   git switch main && git pull
   git tag -a v0.5.0 -m "v0.5.0"
   git push origin v0.5.0
   ```

5. **Approve the deployment.** `publish` sits on the `npm-publish` environment.
   In the run page: **Review deployments** → `npm-publish` → **Approve and
   deploy**. Check the build and verify jobs are green before clicking; this is
   the last reversible moment.

### Three gates decide the version number, so they cannot disagree

`verify-prebuilds.mjs` refuses to publish unless the tag equals
`package.json`'s version, `package-lock.json` carries that version in both
places it records one, and `CHANGELOG.md` has a section for it. The last one is
checked before publish because the GitHub release body is cut from that section
— discovering it missing afterwards would be discovering it on a version that
cannot be recalled.

## `Bypassed rule violations` is not an error

Deleting or creating a `v*` tag prints this:

```
remote: Bypassed rule violations for refs/tags/v0.5.0:
remote: - Cannot create ref due to creations being restricted.
 * [new tag]         v0.5.0 -> v0.5.0
```

It is an audit record: the ruleset *would* have refused, and a maintainer on
the bypass list went through anyway. The rule is doing its job — it stops
everyone else from firing a release, and stops a script from deleting one.

Read the last line, not the `remote:` lines. `* [new tag]` and `- [deleted]`
are successes. A real refusal prints `! [remote rejected]` and no success line.

## When it fails

The dividing line is `npm publish`. Everything before it is free to retry;
nothing after it is.

**Before publish** — nothing reached the registry. Fix on a branch, merge, then
reuse the same version:

```sh
git push origin :refs/tags/v0.5.0
git tag -d v0.5.0
git tag -a v0.5.0 -m "v0.5.0"
git push origin v0.5.0
```

Confirm with `npm view nanoepoch dist-tags` before assuming this. It costs one
command and it is the difference between a re-tag and a burned version.

**After publish** — the version is permanent. npm forbids republishing a
version, and unpublishing removes the fix rather than the problem. Fix forward
with a patch release, then `npm deprecate` the bad one by hand (it needs an
OTP, deliberately not automated). The `alarm` job files an issue saying this,
so the runbook arrives without anyone remembering where it is.

## What the first release after a toolchain change actually exercises

CI compiles every supported target on every pull request, but it only builds
two of the eight prebuilds the way a release builds them: `prebuild-linux-x64`
runs `build-prebuild.sh` in `manylinux_2_28_x86_64` and `node:24-alpine`, then
checks what comes out. That check belongs there and not on the test matrix
because Ubuntu's GCC applies most of those flags by default — a local
`npm run dev:build` would go green whether or not `binding.gyp` had any
effect.

**The other six binaries are first produced by that pipeline when the tag is
pushed.** For four of them it is also the first time any hardening check sees
them:

- `linux-arm64` glibc, under `manylinux_2_28_aarch64`
- `linux-arm64` musl
- `darwin-x64` and `darwin-arm64`

Windows is the exception. MSVC does not set `/guard:cf` on its own, so a
local build proves the flag reached the linker, and `ci.yml` runs that check
on both `windows-latest` and `windows-11-arm`. macOS is the weakest of the
four — its step *reports* what it found instead of failing on it, and the
stack-protector assertion stays a note rather than a fault until a release
has shown it true on both darwin targets. Nothing names `linux-arm64` at all;
it is covered only by the sweep `verify-prebuilds.mjs` makes over all eight
binaries just before publish.

This is not a reason to avoid tagging — the gates run before `npm publish`, so
the failure mode is a red release, not a bad artifact. It *is* a reason to
expect the first tag after a build change to fail, and to have the re-tag
sequence above to hand.

## What went wrong shipping 0.4.0

Four attempts. Each one stopped before `npm publish`, which is the system
working, but each was a check that had never run.

**1. The gate's library table was wrong, not the binary.**
`--as-needed` dropped `libstdc++`, `libm`, `libgcc_s` and `libpthread` from
both Linux glibc builds as intended — and on aarch64 the binary then named
`ld-linux-aarch64.so.1`, which the exact-set rule refused. The loader is not a
dependency: it is the code that *processes* `DT_NEEDED`, mapped before it reads
the first entry. Confirmed by pulling the published 0.3.1 binaries and reading
them: both arches carried the same five libraries and neither named the loader,
so this was `--as-needed` exposing a toolchain property, not causing one.
Now tolerated, per target, in `DYNAMIC_LINKER`.

**2. The gate corrupted the check that read it.**
`verify-prebuilds.mjs` printed its success line to stdout. It runs as
`prepublishOnly`, so `npm publish --dry-run --json > file` put that line above
the JSON and the parse died. See never-do rule 4 in [`SECURITY.md`](SECURITY.md).

**3. npm changed the shape of `publish --json`, and the reader failed open.**
Between npm 11.13 and 11.17 the report went from `{ filename, files, … }` to
`{ "<name>": { filename, files, … } }`. The reader found no `files`, and
`(entry.files || [])` turned the search for a `*.gyp` at the tarball root into
a loop over an empty list. It printed `0 files, integrity undefined` and would
have **passed** — in the one step whose job is to prove npm is not about to
upload a manifest with an install script — had a later line not thrown on the
undefined. The crash was luck.

That third one is the lesson worth keeping:

> **A check that cannot find its input must refuse, not pass.**
> Absence of findings is not a finding of absence, and every gate here is
> written so that an unrecognised input is a refusal naming what it did see.

Two corollaries earned the same way:

- **Verify against the toolchain CI uses, not the one on your machine.** The
  npm shape change was invisible locally because this machine had npm 11.13.
  Reproducing it took one `docker run node:24`. The same applies to the
  compiler: `binding.gyp` flags are checked on the real `manylinux` and Alpine
  artifacts rather than on a runner build, because Ubuntu's GCC and Alpine's
  toolchain apply most of them by default and would go green regardless.
- **Logic that gates a release does not live in YAML.** Three separate controls
  moved into `scripts/lib/` after proving untestable in place —
  [`ci-required.mjs`](scripts/lib/ci-required.mjs),
  [`changelog.mjs`](scripts/lib/changelog.mjs) and
  [`publish-manifest.mjs`](scripts/lib/publish-manifest.mjs). The first was
  written twice because extracting it from the workflow to run it once kept
  failing; the second silently matched nothing because a regex lost its
  backslashes to two layers of quoting; the third shipped the fail-open above.

## Cleaning up

Delete merged branches after a release. `main` is the only long-lived branch.

```sh
git branch --merged main | grep -v '^\*\|main' | xargs -r git branch -d
git push origin --delete <branch> ...
```
