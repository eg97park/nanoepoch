// scripts/verify-prebuilds.mjs is the last gate before npm publish, and the
// only one that sees the prebuilds AFTER the four platform artifacts are merged
// into one tree. These tests feed it deliberately wrong trees -- every binary a
// real one from this checkout, every corruption one a broken merge could
// produce -- and assert it refuses each with a message naming the actual fault.
//
// Skipped wholesale when the checkout does not carry all six prebuilds, which
// is the normal state right after clone: the fixtures are built by cross-
// planting real binaries between directories, so all of them have to exist.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(packageRoot, 'scripts', 'verify-prebuilds.mjs')

const EXPECTED = [
  'win32-x64/nanoepoch.node',
  'win32-arm64/nanoepoch.node',
  'linux-x64/nanoepoch.glibc.node',
  'linux-x64/nanoepoch.musl.node',
  'linux-arm64/nanoepoch.glibc.node',
  'linux-arm64/nanoepoch.musl.node'
]

const haveAll = EXPECTED.every((relative) => existsSync(join(packageRoot, 'prebuilds', relative)))
const skip = haveAll ? false : 'needs all six prebuilds (a release checkout); run the release build first'

const fixtures = []

// Start from a correct tree of real binaries, then let the test break it.
function makeTree (mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'nanoepoch-guard-'))
  fixtures.push(root)
  for (const relative of EXPECTED) {
    const target = join(root, 'prebuilds', ...relative.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(packageRoot, 'prebuilds', relative), target)
  }
  mutate(join(root, 'prebuilds'))
  return root
}

function run (root) {
  const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
  return { status: result.status, out: result.stdout + result.stderr }
}

test.after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

test('a correct tree of real binaries passes', { skip }, () => {
  const { status, out } = run(makeTree())
  assert.equal(status, 0, out)
  assert.match(out, /architectures and libc links verified/)
})

test('an arm64 binary hiding under an x64 name is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'linux-arm64', 'nanoepoch.glibc.node'),
      join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1, 'a wrong-architecture binary must fail the release')
  assert.match(out, /architecture mismatch: prebuilds\/linux-x64\/nanoepoch\.glibc\.node/)
})

test('a wrong-architecture Windows binary is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'win32-x64', 'nanoepoch.node'),
      join(prebuilds, 'win32-arm64', 'nanoepoch.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /architecture mismatch: prebuilds\/win32-arm64\/nanoepoch\.node/)
})

test('a glibc binary wearing a musl filename is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node'),
      join(prebuilds, 'linux-x64', 'nanoepoch.musl.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1, 'the loader would hand this binary to musl hosts, so it must never ship')
  assert.match(out, /libc mismatch: prebuilds\/linux-x64\/nanoepoch\.musl\.node is tagged musl but is linked against glibc/)
})

test('a musl binary wearing a glibc filename is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'linux-x64', 'nanoepoch.musl.node'),
      join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /libc mismatch: prebuilds\/linux-x64\/nanoepoch\.glibc\.node is tagged glibc but is linked against musl/)
})

test('garbage bytes under a binary name are refused as not a binary', { skip }, () => {
  const root = makeTree((prebuilds) => {
    // Over the 4096-byte floor so this exercises the header check, not the
    // size check.
    writeFileSync(join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node'), 'x'.repeat(8192))
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /not an ELF file: prebuilds\/linux-x64\/nanoepoch\.glibc\.node/)
})

test('a stray file inside prebuilds/ is reported, not crashed on', { skip }, () => {
  const root = makeTree((prebuilds) => {
    writeFileSync(join(prebuilds, '.DS_Store'), 'junk')
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /unexpected non-directory entry: prebuilds\/\.DS_Store/)
  assert.doesNotMatch(out, /ENOTDIR/, 'the guard should report the entry, not throw on it')
})

test('a missing prebuild is still refused with the exact path', { skip }, () => {
  const root = makeTree((prebuilds) => {
    rmSync(join(prebuilds, 'win32-arm64', 'nanoepoch.node'))
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /missing prebuild: prebuilds\/win32-arm64\/nanoepoch\.node/)
})
