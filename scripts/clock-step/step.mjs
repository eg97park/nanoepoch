// Design section 11(e): the test that demonstrates why this package exists.
//
// Step the system clock backwards by 5 seconds and watch what each technique
// reports. nanoepoch, which reads CLOCK_REALTIME on every call, sees the step.
// The anchored technique every other package uses -- capture a base instant
// once, then add elapsed monotonic time -- does not, and keeps confidently
// returning timestamps that are now five seconds wrong.
//
// Deliberately outside test/: `node --test` discovers every .mjs under a test
// directory regardless of filename, and moving the clock out from under the
// rest of the suite would fail those tests for reasons that have nothing to do
// with the code. Run it through scripts/clock-step/run.sh, which stops the time
// daemons first and passes this path explicitly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { now } = require('../../index.js')

// The step is performed with `sudo date`, so this is Linux-only even when the
// opt-in variable is set.
const enabled = process.env.NANOEPOCH_CLOCK_STEP === '1' && process.platform === 'linux'
const STEP_SECONDS = 5
const NS = 1_000_000_000n

// The forbidden technique, written out in full so the contrast is concrete.
// Never exported, never importable: this is what nanoepoch refuses to be.
function makeAnchoredClock () {
  const anchor = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint()
  return () => anchor + process.hrtime.bigint()
}

function setClock (expression) {
  execFileSync('sudo', ['-n', 'date', '-s', expression], { stdio: 'pipe', timeout: 30_000 })
}

const seconds = (ns) => (Number(ns) / 1e9).toFixed(3)

test('a backward clock step is visible to nanoepoch and invisible to an anchored clock', {
  skip: enabled ? false : 'linux only, and set NANOEPOCH_CLOCK_STEP=1 (see scripts/clock-step/run.sh)'
}, (t) => {
  const anchoredNow = makeAnchoredClock()

  // Monotonic reference for the restore below. A relative "+5 seconds" would
  // move the clock even when the step never landed, leaving the machine five
  // seconds in the future -- the opposite of what a cleanup should do.
  const monoBefore = process.hrtime.bigint()
  const realBefore = now()
  const anchoredBefore = anchoredNow()

  let realAfter, anchoredAfter, stepDuration

  try {
    const monoStepStart = process.hrtime.bigint()
    setClock(`-${STEP_SECONDS} seconds`)
    stepDuration = process.hrtime.bigint() - monoStepStart

    realAfter = now()
    anchoredAfter = anchoredNow()
  } finally {
    // Restore to an absolute instant derived from monotonic elapsed time, so it
    // is correct whether the step landed fully, partially, or not at all.
    const expected = realBefore + (process.hrtime.bigint() - monoBefore)
    const drift = now() - expected
    if (drift > NS / 2n || drift < -NS / 2n) {
      const epochSeconds = (Number(expected) / 1e9).toFixed(6)
      setClock(`@${epochSeconds}`)
    }
  }

  const realDelta = realAfter - realBefore
  const anchoredDelta = anchoredAfter - anchoredBefore
  const report = `nanoepoch saw ${seconds(realDelta)}s, anchored clock saw ${seconds(anchoredDelta)}s, ` +
    `the step command took ${seconds(stepDuration)}s`

  t.diagnostic(`system clock stepped back ${STEP_SECONDS}s`)
  t.diagnostic(`nanoepoch.now()  delta ${seconds(realDelta)}s  <- followed the step`)
  t.diagnostic(`anchored clock   delta ${seconds(anchoredDelta)}s  <- missed the step entirely`)
  t.diagnostic(`anchored clock is now ${seconds(anchoredAfter - realAfter)}s ahead of the true time`)

  // The headline contrast: opposite signs across the same instant.
  assert.ok(realDelta < 0n, `nanoepoch should have moved backwards. ${report}`)
  assert.ok(anchoredDelta > 0n, `the anchored clock should have kept moving forwards. ${report}`)

  // Both deltas are compared against the measured duration of the step command
  // rather than a fixed budget, so a slow sudo on a loaded runner cannot fail a
  // correct implementation.
  const tolerance = 250_000_000n
  const expectedReal = stepDuration - BigInt(STEP_SECONDS) * NS
  assert.ok(
    realDelta > expectedReal - tolerance && realDelta < expectedReal + tolerance,
    `nanoepoch should have tracked the step exactly. ${report}`
  )
  assert.ok(
    anchoredDelta > stepDuration - tolerance && anchoredDelta < stepDuration + tolerance,
    `the anchored clock should have advanced by the step command's duration and nothing else. ${report}`
  )

  // What that costs the anchored clock: it is now wrong by the step amount.
  const anchoredError = anchoredAfter - realAfter
  assert.ok(
    anchoredError > 4n * NS,
    `the anchored clock should now be about ${STEP_SECONDS}s ahead of the true time, was ${seconds(anchoredError)}s`
  )
})
