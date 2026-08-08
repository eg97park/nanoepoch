# Security

## Supported versions

Security fixes land on the latest 0.x release only. There are no maintenance
branches while the package is pre-1.0.

| Version | Status |
|---|---|
| `0.4.0` | Supported |
| `0.3.1` | Superseded — installs and runs correctly, but its binaries predate the hardening flags and the gate that checks them |
| `0.3.0` | Deprecated — the published manifest declared an implicit `node-gyp rebuild` the tarball could not satisfy, so every install failed |
| `0.2.x` | Deprecated — ran an install script |
| `0.1.0` | Deprecated — no prebuilt binaries |

Superseded is not deprecated. A version is deprecated on npm only when installing
it is a mistake — it is broken, or it runs something it should not. A working
older release is left alone.

Node.js version support is a separate axis and lives in the README's
[Support table](README.md#support).

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** button on the Security tab, which opens
a private advisory. (That button only appears while private vulnerability
reporting is enabled for the repository; if you cannot see it, open a normal
issue saying only that you have a security report and nothing more, and you will
be sent somewhere private.)

Please do not open a public issue with details first.

This is a single-maintainer package. Response is best effort — there is no
service level agreement, and none is implied by this file.

### In scope

- Anything that causes code to run at install time, or that would let a tarball
  do so.
- The binary resolution in [`index.js`](index.js): which file gets loaded, and
  whether anything outside the package directory can influence it.
- Integrity of the eight prebuilt binaries and of the provenance that covers
  them.
- Memory safety in [`src/nanoepoch.c`](src/nanoepoch.c).

### Out of scope

- The accuracy of your host clock. nanoepoch reports what the OS realtime clock
  says; how close that is to UTC is an NTP configuration question. See
  [Resolution is not accuracy](README.md#resolution-is-not-accuracy).
- Using timestamps from a non-monotonic clock for ordering, uniqueness, or
  duration. The README says not to, at length.
- The deprecated versions in the table above.

## How releases are made

Every one of these is checkable from outside:

- **Publishing uses OIDC trusted publishing.** No long-lived npm token exists
  for this package, so there is none to leak. Publishing happens only from
  [`.github/workflows/release.yml`](.github/workflows/release.yml), on a
  `v*` tag, through the `npm-publish` environment.
- **Nothing runs at install time.** No install, preinstall, or postinstall
  script; no `*.gyp` at the tarball root; `"gypfile": false` in the manifest.
  The release gate refuses to publish if any of the three is lost, and the
  workflow re-reads the published manifest from the registry afterwards.
- **The release gate reads the binaries.** Before publish,
  [`scripts/verify-prebuilds.mjs`](scripts/verify-prebuilds.mjs) checks each
  binary's ELF, PE, or Mach-O header against the platform its filename claims,
  the exact set of libraries it links, the hardening the linker was asked to
  apply, and its SHA-256 against the record the build job wrote.
- **Provenance and attestations.** The tarball carries npm provenance; each
  binary additionally carries a GitHub build attestation. Verify with
  `npm audit signatures` and `gh attestation verify`.
- **Every GitHub Action is pinned to a full commit SHA**, updated weekly by
  dependabot.
- **A bad release is fixed forward.** Nothing is ever unpublished: npm forbids
  republishing a version, so withdrawing one only removes the fix. The broken
  version is deprecated by hand and the next patch supersedes it.

## Four things this package must never do

Recorded here because each one is an easy, plausible change that would quietly
break a promise the package is built on.

1. **Never add `binding.gyp` to `"files"`, or any `*.gyp` to the tarball root.**
   npm treats a `binding.gyp` in an installed package's root as an implicit
   `node-gyp rebuild` even when no install script is declared anywhere. The
   auditable copy lives in [`build-recipe/`](build-recipe/), one directory down,
   where npm's root-only checks cannot see it.
2. **Never add an install, preinstall, or postinstall script**, and never remove
   `"gypfile": false`. Without that field npm writes the implicit install script
   into the manifest it uploads, even though the tarball has no gyp file to
   satisfy it. That is precisely what broke 0.3.0.
3. **Never add `"os"` or `"cpu"` to package.json.** It looks like the obvious
   thing to do for a package shipping eight platform binaries, and it would
   replace the load-time diagnostic — which names the detected platform, the
   bundled binaries, and the way out — with npm's `EBADPLATFORM`, at install
   time, with none of that detail. Failing loudly and informatively at `require`
   is the design.
4. **Never print to stdout from anything npm runs as a lifecycle script.**
   `prepublishOnly` runs [`scripts/verify-prebuilds.mjs`](scripts/verify-prebuilds.mjs),
   and npm's `--json` modes use stdout as a data channel: `npm publish --dry-run
   --json > file` puts whatever a lifecycle script printed at the *top* of that
   file, ahead of the JSON. The release parses exactly that file to confirm npm
   is not about to upload a manifest carrying an install script — so a success
   message on stdout breaks the check that reads it. Report through stderr;
   [`test/release-guard.test.mjs`](test/release-guard.test.mjs) asserts the gate
   contains no `console.log` at all.
