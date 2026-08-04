// API surface, argument validation, and multi-instance safety.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const nanoepoch = require('../index.js')
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// Mid-2025 to roughly 2096: wide enough never to flake, narrow enough that a
// 1601-based value (~1.3e19) or a microsecond value (~1.8e15) fails instantly.
const LOWER = 1_750_000_000_000_000_000n
const UPPER = 4_000_000_000_000_000_000n

test('the module exports exactly the documented surface', () => {
  assert.deepEqual(Object.keys(nanoepoch), ['now', 'nowMicros', 'nowInto'])
  for (const name of ['now', 'nowMicros', 'nowInto']) {
    assert.equal(typeof nanoepoch[name], 'function', `${name} should be a function`)
  }
})

test('now() returns a plausible BigInt nanosecond timestamp', () => {
  const value = nanoepoch.now()
  assert.equal(typeof value, 'bigint')
  assert.ok(value > LOWER && value < UPPER, `now() out of range: ${value}`)
})

test('nowMicros() returns a safe integer', () => {
  const value = nanoepoch.nowMicros()
  assert.equal(typeof value, 'number')
  assert.ok(Number.isSafeInteger(value), `not a safe integer: ${value}`)
  assert.ok(value > 1_750_000_000_000_000 && value < 4_000_000_000_000_000)
})

test('nowInto() writes at the default and explicit indices', () => {
  const signed = new BigInt64Array(4)
  nanoepoch.nowInto(signed)
  assert.ok(signed[0] > LOWER && signed[0] < UPPER)
  assert.equal(signed[1], 0n, 'only the target slot should be written')

  nanoepoch.nowInto(signed, 3)
  assert.ok(signed[3] > LOWER && signed[3] < UPPER)
  assert.equal(signed[2], 0n)

  const unsigned = new BigUint64Array(2)
  nanoepoch.nowInto(unsigned, 1)
  assert.ok(unsigned[1] > LOWER && unsigned[1] < UPPER)
  assert.equal(unsigned[0], 0n)

  // An explicit undefined must behave like an omitted argument.
  const dflt = new BigUint64Array(1)
  nanoepoch.nowInto(dflt, undefined)
  assert.ok(dflt[0] > LOWER)
})

test('nowInto() writes through a subarray view at the right offset', () => {
  const backing = new BigUint64Array(8)
  const view = backing.subarray(4)
  nanoepoch.nowInto(view, 1)
  assert.ok(backing[5] > LOWER && backing[5] < UPPER)
  for (const i of [0, 1, 2, 3, 4, 6, 7]) {
    assert.equal(backing[i], 0n, `index ${i} should be untouched`)
  }
})

test('nowInto() rejects targets it cannot write 64-bit values into', () => {
  // No arguments at all takes a different branch from an explicit undefined.
  assert.throws(() => nanoepoch.nowInto(), { name: 'TypeError' })

  for (const bad of [undefined, null, 0, 'x', {}, [], new Float64Array(1), new Int32Array(2), new ArrayBuffer(8)]) {
    assert.throws(() => nanoepoch.nowInto(bad), { name: 'TypeError' },
      `expected a TypeError for ${Object.prototype.toString.call(bad)}`)
  }
})

test('nowInto() rejects out-of-bounds and malformed indices', () => {
  const target = new BigUint64Array(2)
  assert.throws(() => nanoepoch.nowInto(target, 2), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, 99), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, -1), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, 1.5), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, NaN), { name: 'RangeError' })
  // Values past 2^32 must be rejected by an explicit bound, never by whatever a
  // double-to-uint32 conversion happens to produce on this architecture.
  assert.throws(() => nanoepoch.nowInto(target, Infinity), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, 2 ** 32), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, 1e30), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, Number.MAX_VALUE), { name: 'RangeError' })
  assert.throws(() => nanoepoch.nowInto(target, '1'), { name: 'TypeError' })
  assert.deepEqual(Array.from(target), [0n, 0n], 'no write should have happened')
})

test('nowInto() rejects an empty target without blaming detachment', () => {
  // An empty array and a detached one are indistinguishable through Node-API 6,
  // so the message must not claim to know which it is.
  assert.throws(() => nanoepoch.nowInto(new BigUint64Array(0)), (err) =>
    err instanceof RangeError && /either empty or/.test(err.message))
})

test('nowInto() throws instead of writing through a detached buffer', () => {
  const target = new BigUint64Array(1)
  structuredClone(target.buffer, { transfer: [target.buffer] })
  assert.equal(target.length, 0, 'buffer should be detached')
  assert.throws(() => nanoepoch.nowInto(target), { name: 'RangeError' })
})

test('the ESM entry exposes the same functions as the CommonJS entry', async () => {
  const esm = await import('../index.mjs')
  assert.deepEqual(Object.keys(esm).sort(), ['now', 'nowInto', 'nowMicros'])
  assert.equal(esm.now, nanoepoch.now, 'both entries share one binding instance')
  assert.equal(esm.nowMicros, nanoepoch.nowMicros)
  assert.equal(esm.nowInto, nanoepoch.nowInto)
  assert.ok(esm.now() > LOWER)
})

test('the addon loads and works inside a worker thread', async () => {
  const source = `
    const { parentPort } = require('node:worker_threads')
    const { now, nowInto } = require(${JSON.stringify(join(packageRoot, 'index.js'))})
    const buffer = new BigUint64Array(1)
    nowInto(buffer)
    parentPort.postMessage({ now: String(now()), into: String(buffer[0]) })
  `
  const worker = new Worker(source, { eval: true })
  try {
    const [message] = await once(worker, 'message')
    assert.ok(BigInt(message.now) > LOWER && BigInt(message.now) < UPPER)
    assert.ok(BigInt(message.into) > LOWER && BigInt(message.into) < UPPER)
  } finally {
    await worker.terminate()
  }
})

test('the clock advances with real time', () => {
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const before = nanoepoch.now()
  sleep(50)
  const elapsedMs = Number(nanoepoch.now() - before) / 1e6
  assert.ok(elapsedMs >= 40 && elapsedMs < 5000, `elapsed ${elapsedMs}ms after a 50ms sleep`)
})
