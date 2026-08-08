# Rebuilding the binary you were shipped

This directory holds the `binding.gyp` the published binaries were compiled
with. Together with `src/nanoepoch.c` and `BUILD-INFO.json` — both also in the
tarball — it is everything needed to compile the addon yourself and compare the
result against what was published.

It lives here rather than at the package root for one specific reason. npm
treats a `binding.gyp` **in the root of an installed package** as an implicit
`node-gyp rebuild`, even when the package declares no install script at all,
and it globs the publish directory's root for `*.gyp` when preparing the
manifest it uploads. Both checks look at the root and only the root
(`@npmcli/node-gyp` stats `<package>/binding.gyp`; `@npmcli/package-json`'s
normalizer globs `*.gyp` non-recursively). A copy one directory down is
therefore invisible to them, which is how this package can ship a build recipe
and still run nothing at install time.

Shipping it at the root instead is what broke 0.3.0 for every installer.

## Reproducing

```sh
cd node_modules/nanoepoch          # or wherever you unpacked the tarball
cp build-recipe/binding.gyp .
npx --yes node-gyp@13 rebuild --release
sha256sum build/Release/nanoepoch.node
```

Compare that hash against the entry for your platform in `BUILD-INFO.json`:

```sh
node -e 'const i=require("./BUILD-INFO.json"); for (const b of i.binaries) console.log(b.sha256, b.path)'
```

Remove the copied `binding.gyp` afterwards if you plan to reinstall anything in
that tree — with it present, npm compiles the package on the next install.

## What will and will not match

`BUILD-INFO.json` records, for every binary, the Node version, the node-gyp
version, the compiler banner, and the container image digest or runner image
that produced it. Matching the published hash means matching all of that.

- **Linux, same container image**: expected to match. The binaries are
  `strip --strip-all`ed, so they carry no absolute paths, and the only build
  residue is the compiler version string in `.comment` plus a content-derived
  build ID. The images are named by digest in `BUILD-INFO.json`.
- **A different compiler or distribution**: will not match, and that is not a
  finding. Compare the disassembly or the behaviour, not the hash.
- **macOS and Windows**: will not match. Mach-O carries a UUID and PE records a
  link timestamp, neither of which is derived from the input alone.

The source hashes in `BUILD-INFO.json` are the part that holds in every case:
`src/nanoepoch.c` and `binding.gyp` are recorded as they were read inside each
build container, and the release refuses to publish if the files in the tarball
do not hash to those values. So the source next to the binary is provably the
source the binary was built from, whether or not your compiler reproduces the
same bytes.

## Verifying without rebuilding

The tarball is covered by npm provenance, and each binary additionally carries a
GitHub build attestation:

```sh
npm audit signatures
gh attestation verify node_modules/nanoepoch/prebuilds/<platform>/<file>.node \
  --repo eg97park/nanoepoch
```
