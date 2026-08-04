// Design section 11(b) and 11(c): does the value agree with other clocks, and
// do the three APIs agree with each other?
//
// Tolerances here are deliberately loose. The bugs worth catching are enormous
// -- a wrong 1601 epoch offset is off by 369 years, a microsecond/nanosecond
// scaling slip is off by 1000x -- so a wide tolerance loses no detection power
// while staying immune to GC pauses and scheduling noise on shared CI runners.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { now, nowMicros, nowInto } = require('../index.js')

const NS_PER_MS = 1_000_000n
const NS_PER_SEC = 1_000_000_000n
const LOWER = 1_750_000_000_000_000_000n
const UPPER = 4_000_000_000_000_000_000n

// Two clock reads can never be atomic, so every comparison below sandwiches the
// value under test between two reads of the reference. A real NTP step landing
// inside that window can legitimately invert the bracket; a systematic ordering
// bug fails every time. Retrying three times separates the two.
function withRetries (attempts, body) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      body()
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

test('values sit in a plausible range for the current era', () => {
  for (let i = 0; i < 100; i++) {
    const value = now()
    assert.ok(value > LOWER && value < UPPER, `out of range: ${value}`)
  }
})

test('now() agrees with Date.now() to well within 100ms', () => {
  // 100ms, not 1ms: Date.now() is truncated to milliseconds, and V8 on Windows
  // does not necessarily refresh its wall clock on every call. Anything this
  // test exists to catch is off by days or by a factor of 1000.
  const toleranceNs = 100n * NS_PER_MS
  for (let i = 0; i < 100; i++) {
    const before = BigInt(Date.now()) * NS_PER_MS
    const value = now()
    const after = BigInt(Date.now()) * NS_PER_MS

    const low = before - toleranceNs
    const high = after + NS_PER_MS + toleranceNs
    assert.ok(value >= low && value <= high,
      `now()=${value} outside [${low}, ${high}] built from Date.now()`)
  }
})

test('now() agrees with a clock read outside this process', () => {
  // V8 derives Date.now() from the same OS clock this addon reads, so agreeing
  // with it cannot rule out a bug the two share. A separate process can.
  const before = now()
  const external = externalUnixSeconds() * NS_PER_SEC
  const after = now()

  // Whole seconds, because BusyBox date (Alpine) silently ignores the %N
  // nanosecond conversion and returns seconds regardless -- which would make a
  // millisecond-based assertion wrong by a factor of 1000 on musl only.
  // Truncation puts the external reading up to 1s behind, and process spawn
  // latency is unbounded on a loaded runner, hence the slack. Precision is not
  // the point here: this test catches epoch and scale errors, which are off by
  // days or by 1000x.
  const slack = 2n * NS_PER_SEC
  const low = before - NS_PER_SEC - slack
  const high = after + slack
  assert.ok(external >= low && external <= high,
    `external clock ${external} outside [${low}, ${high}]`)
})

test('nowMicros() is a faithful coarsening of now()', () => {
  withRetries(3, () => {
    for (let i = 0; i < 50; i++) {
      const before = now()
      const micros = BigInt(nowMicros())
      const after = now()
      assert.ok(micros >= before / 1000n - 1n && micros <= after / 1000n + 1n,
        `nowMicros()=${micros} outside [${before / 1000n}, ${after / 1000n}]`)
    }
  })
})

test('nowInto() reports the same clock as now()', () => {
  const target = new BigUint64Array(1)
  withRetries(3, () => {
    for (let i = 0; i < 50; i++) {
      const before = now()
      nowInto(target)
      const after = now()
      assert.ok(target[0] >= before && target[0] <= after,
        `nowInto()=${target[0]} outside [${before}, ${after}]`)
    }
  })
})

test('signed and unsigned targets receive identical bits', () => {
  // Two views over one buffer, so a single write can be read both ways. Two
  // separate writes would only prove the clock advanced, not that the addon's
  // signed and unsigned branches store the same value.
  const buffer = new ArrayBuffer(8)
  const signed = new BigInt64Array(buffer)
  const unsigned = new BigUint64Array(buffer)

  for (let i = 0; i < 50; i++) {
    nowInto(signed)
    assert.equal(unsigned[0], BigInt.asUintN(64, signed[0]))
    assert.ok(signed[0] > LOWER && signed[0] < UPPER,
      `a signed target must receive the real value, not a wrapped one: ${signed[0]}`)

    nowInto(unsigned)
    assert.equal(signed[0], BigInt.asIntN(64, unsigned[0]))
    assert.ok(unsigned[0] > LOWER && unsigned[0] < UPPER)
  }
})

function externalUnixSeconds () {
  const options = { encoding: 'utf8', timeout: 30_000 }
  const output = process.platform === 'win32'
    ? execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()'],
      options)
    : execFileSync('date', ['+%s'], options)
  const seconds = BigInt(output.trim())
  // Guard against a date implementation that silently returns something else:
  // an unparsed format string would otherwise become a confusing range failure.
  assert.ok(seconds > 1_750_000_000n && seconds < 4_000_000_000n,
    `the external clock command returned an implausible value: ${output.trim()}`)
  return seconds
}
