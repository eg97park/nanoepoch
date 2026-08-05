// scripts/prebuild.mjs argument validation. Only the paths that exit BEFORE
// node-gyp runs are tested here -- they must stay fast and toolchain-free, so
// this file can run on any platform, including one with no compiler at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prebuild.mjs')

function run (args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 })
  return { status: result.status, out: result.stdout + result.stderr }
}

test('an invalid --libc value fails before any compilation', () => {
  const { status, out } = run(['--libc', 'bogus'])
  assert.equal(status, 1)
  assert.match(out, /--libc must be glibc or musl, got "bogus"/)
  // If node-gyp had started, its banner would be here and the failure would
  // have cost a full compile instead of an argument check.
  assert.doesNotMatch(out, /gyp info/)
})

test('--libc with no value fails the same way', () => {
  const { status, out } = run(['--libc'])
  assert.equal(status, 1)
  assert.match(out, /--libc must be glibc or musl, got nothing/)
  assert.doesNotMatch(out, /gyp info/)
})
