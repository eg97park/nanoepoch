# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) —
with the usual 0.x caveat that a minor bump may break something.

This file, not the GitHub release notes, is the record. The notes are generated
from pull request titles, and this repository commits to `main` directly, so
they say almost nothing.

## 0.4.0 — 2026-08-08

### Added

- `test/smoke.test.mjs` ships inside the tarball, so `npm test` in an installed
  package runs a real self-test instead of reporting zero tests and exiting 0.
  CI and the release workflow run it against installed trees on every supported
  platform, which is the check that would have caught the 0.3.0 breakage in the
  place a consumer meets it.
- `BUILD-INFO.json` ships alongside the binaries: the SHA-256 and size of every
  prebuilt binary, the SHA-256 of the source and gyp file they were compiled
  from, and the Node version, node-gyp version, compiler, and container image
  digest of each build. The release gate refuses to publish if the shipped
  source does not hash to what the builds compiled.
- `build-recipe/` ships the `binding.gyp` the binaries were built with, one
  directory below the tarball root so npm cannot mistake it for an install-time
  build, plus instructions for rebuilding and comparing against
  `BUILD-INFO.json`.
- Each prebuilt binary carries a GitHub build attestation, verifiable per file
  with `gh attestation verify`, and the tarball carries an attested CycloneDX
  SBOM.
- The release now installs the *published* package from the registry on all
  eight target platforms across Node 22, 24, and 26 and runs its shipped
  self-test, then compares the installed binaries against their build records.
  Until now every install proof tested a locally packed tarball.
- A release requires the tag to sit on `main` at a commit whose CI run passed.
- A single `ci-required` job that waits on every gating CI job, so the branch
  ruleset needs one stable entry rather than 27 expanded matrix names — 24 of
  which carry a Node version or an image tag and would go stale on the next
  version bump, blocking every merge until an administrator edited the ruleset.
  It carries `if: always()` and fails on any non-success result, because GitHub
  reports a job skipped by a failed dependency to branch protection as a
  success. A test asserts the `needs` list stays equal to every gating job.
- A `### Bundlers` section in the README: mark the package external, and why.

### Changed

- Linux binaries are built with full RELRO, `BIND_NOW`, a stack protector,
  `_FORTIFY_SOURCE=2`, and `--as-needed`; Windows binaries with `/guard:cf`.
  The glibc builds previously had partial RELRO and no stack canary — the musl
  builds had both already, from Alpine's toolchain defaults — and Control Flow
  Guard was off on both Windows targets. The Linux binaries now link `libc` and
  nothing else, where they used to pull in `libstdc++`, `libm`, `libgcc_s`, and
  `libpthread` without using a symbol from any of them.
- The release gate reads each binary's dynamic section and load config: exact
  library set, RELRO, `BIND_NOW`, stack canary, non-executable stack, Control
  Flow Guard, whether it was really stripped, and that the glibc and macOS
  floors are no higher than the README claims.
- The loader prefers `build/Release/nanoepoch.node` by name before falling back
  to scanning the directory. A stale or foreign `.node` sorting before it used
  to win, and because a local build is returned alone, that also hid every
  prebuilt binary behind an error naming a file the project never built.
- `npm run build` is now `npm run dev:build`. Run inside an installed package
  the old name failed with `gyp: binding.gyp not found` — the exact symptom of
  the 0.3.0 breakage, on a package that was fine.
- `"sideEffects"` names the two entry points instead of being `false`.
  Requiring the package deliberately throws when no binary loads, which is a
  side effect, and a bundler that believed otherwise could drop the module and
  with it the deploy-time failure the package exists to produce.
- CI and the release build with `npm ci` rather than `npm install`, so the
  lockfile actually pins what the six build containers compile with.
- The Node tarball each build container downloads is checked against
  `SHASUMS256.txt`.

### Fixed

- The post-publish manifest check no longer dies with `MODULE_NOT_FOUND` when
  the registry never becomes visible — from the one step whose job is to explain
  that class of failure in plain words.
- `npm run attw` runs `npx --ignore-scripts`. It was the only place CI executed
  unpinned third-party lifecycle scripts.

## 0.3.1 — 2026-08-06

### Fixed

- Added `"gypfile": false`, without which npm writes an implicit
  `"install": "node-gyp rebuild"` into the manifest it uploads, regardless of
  what the package declares. 0.3.0 kept `binding.gyp` out of the tarball and
  removed the install script, and still broke every install, because the
  manifest npm *published* did not match the package npm *packed*. The release
  gate now refuses a manifest missing that field, and the workflow re-reads the
  published manifest from the registry after publishing.

## 0.3.0 — 2026-08-06

**Broken; deprecated on npm.** Every install failed with
`gyp: binding.gyp not found`. Use 0.3.1.

### Added

- `darwin-arm64` and `darwin-x64` prebuilt binaries, bringing the matrix to
  eight.

### Removed

- The install script. Nothing runs at install time any more: no lifecycle
  script, and no `binding.gyp` in the tarball. macOS used to reach a working
  binary by compiling from source through that script.

## 0.2.1 — 2026-08-05

**Deprecated on npm**: runs an install script.

## 0.2.0 — 2026-08-04

**Deprecated on npm**: runs an install script.

### Removed

- The `node-gyp-build` runtime dependency. The resolver is about sixty lines
  inlined at the top of `index.js`, which takes the package to zero runtime
  dependencies — and fixes a real misdetection along the way: `node-gyp-build`
  reads `/etc/alpine-release` alone, so a glibc-linked Node in an Alpine
  container is handed a musl binary it cannot load, with no second attempt.

## 0.1.0 — 2026-08-04

**Deprecated on npm**: no prebuilt binaries.

Initial release.
