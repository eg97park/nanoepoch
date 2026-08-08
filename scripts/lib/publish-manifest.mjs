// Reads the report from `npm publish --dry-run --json` and decides whether the
// manifest npm is about to upload would run code on a consumer's machine.
//
// This is the positive control for the 0.3.0 failure. npm does not upload the
// manifest as written: it prepares one from the publish directory, and that
// preparation sets gypfile: true and scripts.install = "node-gyp rebuild" on
// any package whose directory holds a binding.gyp and declares no install
// script of its own. This repository keeps binding.gyp on purpose, so the
// check has to be against what npm REPORTS, not against package.json.
//
// It is a module rather than a `node -e` inside the workflow for the same
// reason lib/ci-required.mjs and lib/changelog.mjs are: a control that cannot
// be tested is a control nobody has checked. That was not academic here -- the
// inline version shipped a fail-open (see findEntry) that ran in a real
// release and reported nothing wrong.

// npm has emitted three shapes for this report.
//
//   npm <= 11.13   { id, name, filename, files, integrity, ... }
//   npm >= 11.17   { "<package name>": { id, name, filename, files, ... } }
//   some versions  [ { ... } ]     (the shape `npm pack --json` still uses)
//
// The 0.4.0 release met the second one having been written against the first,
// so `entry.filename` was undefined, `entry.files` was undefined, and
// `(entry.files || [])` turned the root-gyp check into a loop over an empty
// list that could not fail. The check passed by having nothing to look at.
//
// Hence: identify the entry by a field it must have, and treat "no entry" as a
// refusal rather than as an empty one.
export function findEntry (reported, name) {
  if (Array.isArray(reported)) return reported[0] ?? null
  if (!reported || typeof reported !== 'object') return null
  if (typeof reported.filename === 'string') return reported
  const keyed = reported[name]
  if (keyed && typeof keyed === 'object' && typeof keyed.filename === 'string') return keyed
  return null
}

export function inspect (reported, pkg) {
  const problems = []
  const entry = findEntry(reported, pkg.name)

  if (entry === null) {
    problems.push(
      'could not find the packed entry in what `npm publish --json` reported, so ' +
      'nothing below was actually checked; npm has changed this shape before ' +
      `(top-level keys: ${describe(reported)})`)
    return { problems, entry: null }
  }

  // Read off the manifest this repository will publish. npm's own preparation
  // is what rewrites it, and these are the two fields that rewrite touches.
  const lifecycle = ['preinstall', 'install', 'postinstall'].filter((name) => pkg.scripts?.[name])
  if (lifecycle.length > 0) {
    problems.push(`package.json declares ${lifecycle.join(', ')}; this package runs nothing at install time`)
  }
  if (pkg.gypfile !== false) {
    problems.push('package.json does not set "gypfile": false, so npm will add an install script of its own')
  }

  const files = entry.files
  if (!Array.isArray(files) || files.length === 0) {
    // Never "no files, therefore no problems". An empty list is the state the
    // 0.4.0 release was in when it reported success.
    problems.push('the report lists no files, so the tarball contents were not checked')
    return { problems, entry }
  }

  const paths = files.map((file) => file?.path).filter((path) => typeof path === 'string')
  if (paths.length !== files.length) {
    problems.push('some entries in the report carry no path, so the listing was not fully read')
  }

  // Any bare *.gyp at the root, not the one filename: npm's manifest
  // preparation globs "*.gyp" there, so a check that knows one name is
  // narrower than the rule npm applies. build-recipe/binding.gyp, one
  // directory down, is out of reach of it and is meant to ship.
  const rootGyp = paths.filter((path) => /^[^/]+\.gyp$/.test(path))
  if (rootGyp.length > 0) {
    problems.push(`the tarball would carry ${rootGyp.join(', ')} at its root, which npm compiles at install time`)
  }

  const scripts = paths.filter((path) => path.startsWith('scripts/'))
  if (scripts.length > 0) {
    problems.push(`the tarball would carry ${scripts.join(', ')}; nothing under scripts/ is meant to reach a consumer`)
  }

  if (typeof entry.integrity !== 'string' || entry.integrity === '') {
    problems.push('the report carries no integrity hash to compare against the published one')
  }

  return { problems, entry }
}

function describe (value) {
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `array of ${value.length}`
  if (typeof value !== 'object') return typeof value
  const keys = Object.keys(value)
  return keys.length > 0 ? keys.join(', ') : '(no keys)'
}
