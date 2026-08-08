// The only test file that ships inside the npm tarball, and the reason
// `npm test` means something in an installed package rather than reporting
// "0 tests, 0 failures" and exiting 0.
//
// It is a self-test of a real installation: the release workflow and CI run it
// from inside node_modules/nanoepoch after installing the packed tarball, which
// is the one place a missing prebuild, a broken exports map, or a manifest npm
// rewrote (the 0.3.0 accident) shows up as a failing assertion rather than as a
// bug report.
//
// RULES FOR THIS FILE, because it runs on consumers' machines:
//   - node builtins and this package's own entry points only. No devDependency,
//     nothing under ../scripts or ../bench, no fixtures, no child processes.
//   - no _filetimeToNs or _candidateNames: those hooks are unstable and
//     removable in any release, and a shipped test must not pin them.
//   - no clock-granularity or timing assertions. Those live in the repository's
//     resolution and accuracy suites, which are deliberately diagnostics rather
//     than gates, and would flake on a consumer's shared CI.
// package.json "files" lists this file by its exact path for the same reason:
// `node --test` executes everything under test/, so the directory must never be
// whitelisted wholesale.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Mid-2025 to roughly 2096: wide enough never to flake, narrow enough that a
// 1601-based value (~1.3e19) or a microsecond value (~1.8e15) fails instantly.
const LOWER = 1_750_000_000_000_000_000n
const UPPER = 4_000_000_000_000_000_000n

// The relative path is deliberate here and nowhere else in this file: this
// assertion is about the CommonJS entry point itself, not about resolution.
const nanoepoch = require('../index.js')

test('the installed package exports exactly the documented surface', () => {
  assert.deepEqual(Object.keys(nanoepoch), ['now', 'nowMicros', 'nowInto'])
  for (const name of ['now', 'nowMicros', 'nowInto']) {
    assert.equal(typeof nanoepoch[name], 'function', `${name} should be a function`)
  }
})

test('both entry points resolve through the exports map', async () => {
  // The only runtime exercise the "exports" field ever gets. It resolves by
  // package self-reference in a checkout and as an ordinary dependency inside
  // node_modules, which are the two shapes this file is run in.
  const esm = await import('nanoepoch')
  const cjs = require('nanoepoch')

  assert.equal(typeof esm.now, 'function')
  assert.equal(typeof esm.nowMicros, 'function')
  assert.equal(typeof esm.nowInto, 'function')

  // The ESM wrapper re-exports the CommonJS core rather than loading the addon
  // a second time, so these must be the same functions -- two native instances
  // would be two copies of the addon in one process.
  assert.equal(esm.now, cjs.now)
  assert.equal(esm.nowInto, cjs.nowInto)
})

test('now() returns a plausible BigInt nanosecond timestamp', () => {
  const value = nanoepoch.now()
  assert.equal(typeof value, 'bigint')
  assert.ok(value > LOWER && value < UPPER, `now() out of range: ${value}`)
})

test('nowMicros() returns a safe integer in the matching window', () => {
  const value = nanoepoch.nowMicros()
  assert.equal(typeof value, 'number')
  assert.ok(Number.isSafeInteger(value), `not a safe integer: ${value}`)
  assert.ok(value > Number(LOWER / 1000n) && value < Number(UPPER / 1000n),
    `nowMicros() out of range: ${value}`)
})

test('nowInto() writes into both 64-bit array types, at both index forms', () => {
  for (const Type of [BigInt64Array, BigUint64Array]) {
    const target = new Type(4)

    nanoepoch.nowInto(target)
    assert.ok(BigInt(target[0]) > LOWER, `${Type.name} default index not written`)

    nanoepoch.nowInto(target, 3)
    assert.ok(BigInt(target[3]) > LOWER, `${Type.name} explicit index not written`)
    assert.equal(target[1], 0n, 'nowInto wrote outside the index it was given')
  }
})

test('nowInto() writes through a subarray view at the view offset', () => {
  const backing = new BigUint64Array(4)
  const view = backing.subarray(2)

  nanoepoch.nowInto(view, 1)

  assert.equal(backing[0], 0n)
  assert.equal(backing[1], 0n)
  assert.equal(backing[2], 0n)
  assert.ok(backing[3] > LOWER, 'the write did not land at the view offset')
})

test('nowInto() writes into a SharedArrayBuffer-backed target', () => {
  // The shape a worker-based tracer uses: one buffer, several threads. Nothing
  // in the addon distinguishes it from an ordinary ArrayBuffer, and this is the
  // assertion that keeps it that way.
  const target = new BigUint64Array(new SharedArrayBuffer(8 * 2))

  nanoepoch.nowInto(target, 1)

  assert.equal(target[0], 0n)
  assert.ok(target[1] > LOWER, 'no timestamp was written into the shared buffer')
})

test('nowInto() rejects the wrong target type', () => {
  assert.throws(() => nanoepoch.nowInto(new Float64Array(1)), { name: 'TypeError' })
  assert.throws(() => nanoepoch.nowInto([0n]), { name: 'TypeError' })
  assert.throws(() => nanoepoch.nowInto(), { name: 'TypeError' })
})

test('nowInto() rejects an index that is not a usable slot', () => {
  const target = new BigInt64Array(2)

  assert.throws(() => nanoepoch.nowInto(target, '1'), { name: 'TypeError' })
  assert.throws(() => nanoepoch.nowInto(target, 2), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, -1), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(new BigInt64Array(0)), { name: 'RangeError' })
})
