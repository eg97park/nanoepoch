// Design section 11(d): pin the 1601 -> 1970 conversion with exact vectors.
//
// These run on every platform, not just Windows, because _filetimeToNs is the
// same pure function the Windows read path calls. Exact equality here is the
// only test in the suite that does not depend on what the clock happens to say.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const nanoepoch = require('../index.js')
const filetimeToNs = nanoepoch._filetimeToNs

// Re-derived here rather than copied from the C source: JS Date arithmetic uses
// the proleptic Gregorian calendar and shares no code with the addon, so this
// independently confirms the 369-year, 89-leap-day offset.
const EPOCH_OFFSET_MS = BigInt(Date.UTC(1970, 0, 1) - Date.UTC(1601, 0, 1))
const EPOCH_OFFSET_TICKS = EPOCH_OFFSET_MS * 10_000n

// Largest tick delta whose nanosecond value still fits in a signed 64-bit int.
const MAX_NS = 9_223_372_036_854_775_807n
const MAX_DELTA_TICKS = MAX_NS / 100n

const ticksForUtcMillis = (ms) => (BigInt(ms) + EPOCH_OFFSET_MS) * 10_000n

test('the 1601 -> 1970 offset re-derives to the constant the addon uses', () => {
  assert.equal(EPOCH_OFFSET_MS, 11_644_473_600_000n)
  assert.equal(EPOCH_OFFSET_TICKS, 116_444_736_000_000_000n)
  assert.equal(filetimeToNs(EPOCH_OFFSET_TICKS), 0n)
})

test('conversion is exact at and just past the epoch', () => {
  assert.equal(filetimeToNs(EPOCH_OFFSET_TICKS + 1n), 100n)
  assert.equal(filetimeToNs(EPOCH_OFFSET_TICKS + 10n), 1_000n)
  assert.equal(filetimeToNs(EPOCH_OFFSET_TICKS + 10_000_000n), 1_000_000_000n)
})

test('conversion is exact for known instants', () => {
  // 2020-01-01T00:00:00Z
  assert.equal(
    filetimeToNs(ticksForUtcMillis(Date.UTC(2020, 0, 1))),
    1_577_836_800_000_000_000n
  )

  // A present-day instant. This vector is what proves the subtraction happens
  // before the multiplication: `ticks * 100` for any modern date is about
  // 1.3e19, which has already overflowed a signed 64-bit intermediate, so a
  // multiply-first implementation cannot produce this value.
  assert.equal(
    filetimeToNs(ticksForUtcMillis(Date.UTC(2026, 0, 1))),
    1_767_225_600_000_000_000n
  )
})

test('sub-millisecond ticks survive the conversion', () => {
  const base = ticksForUtcMillis(Date.UTC(2026, 0, 1))
  for (const tick of [1n, 7n, 99n, 1234n, 9999n]) {
    assert.equal(filetimeToNs(base + tick), 1_767_225_600_000_000_000n + tick * 100n)
  }
})

test('the upper bound is the last instant representable as int64 nanoseconds', () => {
  assert.equal(
    filetimeToNs(EPOCH_OFFSET_TICKS + MAX_DELTA_TICKS),
    9_223_372_036_854_775_800n
  )
  assert.throws(
    () => filetimeToNs(EPOCH_OFFSET_TICKS + MAX_DELTA_TICKS + 1n),
    { name: 'RangeError', code: 'ERR_NANOEPOCH_OUT_OF_RANGE' }
  )

  // 2262-04-11T23:47:16.854775807Z is the documented ceiling; a day later must
  // be rejected rather than wrapped into a negative timestamp.
  assert.throws(
    () => filetimeToNs(ticksForUtcMillis(Date.UTC(2262, 3, 13))),
    { name: 'RangeError', code: 'ERR_NANOEPOCH_OUT_OF_RANGE' }
  )
})

test('instants before 1970 are rejected, not wrapped', () => {
  assert.throws(
    () => filetimeToNs(EPOCH_OFFSET_TICKS - 1n),
    { name: 'RangeError', code: 'ERR_NANOEPOCH_BEFORE_EPOCH' }
  )
  assert.throws(
    () => filetimeToNs(0n),
    { name: 'RangeError', code: 'ERR_NANOEPOCH_BEFORE_EPOCH' }
  )
})

test('the tick argument is validated', () => {
  assert.throws(() => filetimeToNs(), { name: 'TypeError' })
  assert.throws(() => filetimeToNs(116444736000000000), { name: 'TypeError' })
  assert.throws(() => filetimeToNs('116444736000000000'), { name: 'TypeError' })
  assert.throws(() => filetimeToNs(-1n), { name: 'RangeError' })
  assert.throws(() => filetimeToNs(2n ** 64n), { name: 'RangeError' })
})

test('the test hook stays out of the public surface', () => {
  assert.deepEqual(Object.keys(nanoepoch), ['now', 'nowMicros', 'nowInto'])
  assert.equal(Object.propertyIsEnumerable.call(nanoepoch, '_filetimeToNs'), false)
})
