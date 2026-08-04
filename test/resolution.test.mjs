// Design section 11(a): measure what the clock actually resolves.
//
// Split by intent: gates assert only what the OS genuinely guarantees, while
// distribution-shaped observations are reported as diagnostics. A resolution
// figure that varies with the hypervisor is information, not a failure.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { now } = require('../index.js')

const SAMPLES = 100_000
const isWindows = process.platform === 'win32'

const samples = new Array(SAMPLES)
for (let i = 0; i < SAMPLES; i++) samples[i] = now()

const deltas = []
let backwards = 0
let zeroDeltas = 0
for (let i = 1; i < SAMPLES; i++) {
  const delta = samples[i] - samples[i - 1]
  if (delta > 0n) deltas.push(delta)
  else if (delta < 0n) backwards++
  else zeroDeltas++
}
deltas.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

const distinct = new Set(samples).size
const percentile = (p) =>
  deltas.length === 0 ? null : deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))]

test('every sample is a BigInt', () => {
  for (let i = 0; i < SAMPLES; i++) {
    if (typeof samples[i] !== 'bigint') {
      assert.fail(`sample ${i} is ${typeof samples[i]}`)
    }
  }
})

test('consecutive calls can be told apart', () => {
  // Every later assertion indexes into deltas, so a stopped clock has to fail
  // here with this message rather than further down with a type error.
  assert.ok(deltas.length > 0, 'no two consecutive samples differed at all: the clock never advanced')
  // A clock that advances only a handful of times across 100k reads is not
  // resolving anything useful, whatever its nominal resolution.
  assert.ok(deltas.length >= SAMPLES / 1000,
    `only ${deltas.length} of ${SAMPLES} reads advanced the clock`)
  assert.ok(distinct > 1, 'every sample was the same value')
})

test('the median gap between calls is far below a millisecond', () => {
  // A nanosecond clock whose typical consecutive-call gap approached 1ms would
  // not be reporting a real clock at all. Deliberately generous: the tight,
  // platform-specific bound lives in the Windows test below.
  const median = percentile(0.5)
  assert.ok(median < 1_000_000n, `median positive delta was ${median}ns`)
})

test('windows values land on the 100ns FILETIME tick', { skip: !isWindows }, () => {
  // GetSystemTimePreciseAsFileTime counts 100ns ticks, so every nanosecond
  // value the addon derives from it is a multiple of 100. A violation is proof
  // of a conversion bug; this is the cheapest strong check available.
  for (let i = 0; i < SAMPLES; i++) {
    if (samples[i] % 100n !== 0n) {
      assert.fail(`sample ${i} = ${samples[i]} is not a multiple of the 100ns tick`)
    }
  }
  assert.equal(deltas[0] % 100n, 0n)
  assert.ok(deltas[0] >= 100n, `smallest positive delta was ${deltas[0]}ns`)
})

test('windows is using the precise clock, not the coarse one', { skip: !isWindows }, () => {
  // GetSystemTimeAsFileTime -- the coarse sibling it would be easy to reach for
  // by mistake -- only advances on the system timer interrupt, so its median
  // consecutive-call delta is at least hundreds of microseconds. The precise
  // API advances every 100ns. Median, not minimum, so VM scheduling outliers
  // cannot trip it.
  const median = percentile(0.5)
  assert.ok(median < 50_000n, `median positive delta was ${median}ns; expected the precise clock`)
})

test('resolution statistics', (t) => {
  t.diagnostic(`platform            ${process.platform}-${process.arch}, node ${process.versions.node}`)
  t.diagnostic(`samples             ${SAMPLES}`)
  t.diagnostic(`distinct values     ${distinct} (${(distinct / SAMPLES * 100).toFixed(2)}%)`)
  t.diagnostic(`repeated readings   ${zeroDeltas}`)
  t.diagnostic(`backward steps      ${backwards} (reported, never gated: CLOCK_REALTIME is not monotonic)`)
  t.diagnostic(`smallest gap        ${deltas[0]}ns`)
  t.diagnostic(`gap p50 / p90 / p99 ${percentile(0.5)}ns / ${percentile(0.9)}ns / ${percentile(0.99)}ns`)
  t.diagnostic(`largest gap         ${deltas[deltas.length - 1]}ns`)

  // Repeats are expected whenever a call completes faster than the clock's tick
  // advances -- on Windows the tick is 100ns and a call costs rather less than
  // that. It only signals a coarse clocksource when the smallest observed gap is
  // itself large.
  if (deltas[0] > 1_000n) {
    t.diagnostic(`note: the smallest observable gap is ${deltas[0]}ns, which suggests a coarse clocksource`)
  }
  if (backwards > 0) {
    t.diagnostic('note: the wall clock moved backwards during the run, which is expected behaviour for a realtime clock')
  }
})
