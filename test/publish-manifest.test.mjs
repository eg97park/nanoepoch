// The step this covers is the positive control for the 0.3.0 breakage: npm
// rewrites the manifest at publish time, so the only honest check is against
// what `npm publish --dry-run --json` says npm would send.
//
// It exists because that check shipped a fail-open and a real release ran it.
// npm changed the report's shape between 11.13 and 11.17 -- wrapping it in the
// package name -- so the reader found no `files`, `(entry.files || [])` made
// that an empty list, and the search for a *.gyp at the tarball root looked at
// nothing and found nothing wrong. It printed "0 files, integrity undefined"
// and would have passed, had a later line not thrown on the undefined.
//
// Two lessons are pinned here: every shape npm has emitted resolves to an
// entry, and anything this code cannot read is a refusal rather than an
// absence of findings.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findEntry, inspect } from '../scripts/lib/publish-manifest.mjs'

// A manifest that should raise nothing, so each case below can change exactly
// one thing and attribute the result to it.
const PKG = {
  name: 'nanoepoch',
  version: '0.4.0',
  gypfile: false,
  scripts: { test: 'node --test', prepublishOnly: 'node scripts/verify-prebuilds.mjs' }
}

const FILES = [
  { path: 'package.json' },
  { path: 'index.js' },
  { path: 'src/nanoepoch.c' },
  { path: 'build-recipe/binding.gyp' },
  { path: 'prebuilds/linux-x64/nanoepoch.glibc.node' }
]

// The fields npm reports, in the shape npm <= 11.13 used.
function report (overrides = {}) {
  return {
    id: 'nanoepoch@0.4.0',
    name: 'nanoepoch',
    version: '0.4.0',
    filename: 'nanoepoch-0.4.0.tgz',
    integrity: 'sha512-abc',
    entryCount: FILES.length,
    files: FILES,
    ...overrides
  }
}

test('every shape npm has emitted resolves to the same entry', () => {
  // npm <= 11.13: the fields sit at the top level.
  assert.equal(findEntry(report(), 'nanoepoch')?.filename, 'nanoepoch-0.4.0.tgz')

  // npm >= 11.17: keyed by package name. This is the one the 0.4.0 release met.
  assert.equal(findEntry({ nanoepoch: report() }, 'nanoepoch')?.filename, 'nanoepoch-0.4.0.tgz')

  // An array, which `npm pack --json` still returns.
  assert.equal(findEntry([report()], 'nanoepoch')?.filename, 'nanoepoch-0.4.0.tgz')
})

test('the keyed shape is read, not reported as an empty tarball', () => {
  // The regression itself. Before the fix this returned no problems at all
  // while checking nothing, which is worse than any specific wrong answer.
  const { problems, entry } = inspect({ nanoepoch: report() }, PKG)
  assert.deepEqual(problems, [])
  assert.equal(entry.files.length, FILES.length)
})

test('a shape this code cannot read is a refusal, not a pass', () => {
  // The whole failure mode in one assertion: npm has changed this report
  // before and will again, and the next change must stop a release rather
  // than silently examine nothing.
  for (const shape of [{}, { somethingElse: {} }, [], null, 'a string', 42]) {
    const { problems } = inspect(shape, PKG)
    assert.ok(problems.length > 0, `${JSON.stringify(shape)} must be refused`)
    assert.match(problems[0], /nothing below was actually checked/)
  }
})

test('a report listing no files is refused rather than found clean', () => {
  // Exactly the state the 0.4.0 release was in. An empty list satisfies every
  // "does the tarball contain X" test by having no contents to contain it.
  for (const files of [[], undefined, null, 'not an array']) {
    const { problems } = inspect(report({ files }), PKG)
    assert.ok(problems.some((problem) => /lists no files/.test(problem)),
      `files: ${JSON.stringify(files)} must be refused`)
  }
})

test('a *.gyp at the tarball root is refused, and one below it is not', () => {
  // npm compiles a package whose tarball ROOT holds a binding.gyp even when no
  // install script exists anywhere, and its manifest preparation globs *.gyp
  // there -- so the rule is any bare name at that level, not one filename.
  const [problem] = inspect(report({ files: [...FILES, { path: 'binding.gyp' }] }), PKG).problems
  assert.match(problem, /binding\.gyp at its root/)

  assert.match(inspect(report({ files: [{ path: 'nanoepoch.gyp' }, ...FILES] }), PKG).problems[0],
    /nanoepoch\.gyp at its root/)

  // build-recipe/binding.gyp is in the clean fixture and raises nothing: one
  // directory down is out of reach of npm's root-only checks, which is the
  // entire reason the recipe can ship.
  assert.deepEqual(inspect(report(), PKG).problems, [])
})

test('shipping scripts/ is refused', () => {
  const { problems } = inspect(report({ files: [...FILES, { path: 'scripts/prebuild.mjs' }] }), PKG)
  assert.match(problems[0], /scripts\/prebuild\.mjs/)
})

test('a manifest that would run code at install time is refused', () => {
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    const { problems } = inspect(report(), { ...PKG, scripts: { [hook]: 'node-gyp rebuild' } })
    assert.ok(problems.some((problem) => problem.includes(hook)), `${hook} must be refused`)
  }

  // Losing "gypfile": false is what actually happened in 0.3.0, and it is
  // invisible in the repository: npm adds the install script during publish.
  const { problems } = inspect(report(), { ...PKG, gypfile: undefined })
  assert.ok(problems.some((problem) => /gypfile/.test(problem)))
})

test('a report with no integrity hash is refused', () => {
  // The published integrity is compared against this one after the upload, so
  // a missing value here would turn that comparison into a no-op.
  for (const integrity of [undefined, '', 42]) {
    const { problems } = inspect(report({ integrity }), PKG)
    assert.ok(problems.some((problem) => /integrity/.test(problem)),
      `integrity: ${JSON.stringify(integrity)} must be refused`)
  }
})
