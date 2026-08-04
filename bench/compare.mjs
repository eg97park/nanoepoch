// Per-call cost of nanoepoch against the clocks Node already ships, plus the
// anchored technique this package exists to replace.
//
// nanoepoch is expected to LOSE to the anchored baseline on throughput. That is
// the point: the anchored baseline is fast because it does not read the clock.
// See scripts/clock-step/run.sh for what that speed actually costs.

import { bench, run, summary, do_not_optimize } from 'mitata'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const nanoepoch = require('../index.js')
// The raw binding is loaded directly so the two candidate now() strategies can
// be compared; published code only ever exposes the winner as nanoepoch.now().
const binding = require('node-gyp-build')(packageRoot)

// The forbidden technique, inlined so it can never be imported by accident:
// anchor once, then report anchor + elapsed monotonic time forever.
const anchorNs = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint()
const anchoredNow = () => anchorNs + process.hrtime.bigint()

const slot = new BigUint64Array(1)
const nowViaSlot = () => {
  binding.nowInto(slot)
  return slot[0]
}

const single = new BigInt64Array(1)
const scratch = new BigInt64Array(1024)
let scratchIndex = 0

summary(() => {
  bench('Date.now()                       [ms, coarse]', () => do_not_optimize(Date.now()))
  bench('performance.now()                [monotonic]', () => do_not_optimize(performance.now()))
  bench('process.hrtime.bigint()          [monotonic]', () => do_not_optimize(process.hrtime.bigint()))
  bench('anchored hrtime shim             [WRONG after a clock step]', () => do_not_optimize(anchoredNow()))
  bench('nanoepoch.now()                  [as shipped]', () => do_not_optimize(nanoepoch.now()))
  bench('nanoepoch.nowMicros()', () => do_not_optimize(nanoepoch.nowMicros()))
  bench('nanoepoch.nowInto(arr)           [zero allocation]', () => {
    nanoepoch.nowInto(single)
  })
  bench('nanoepoch.nowInto(arr, i)        [zero allocation, ring buffer]', () => {
    nanoepoch.nowInto(scratch, scratchIndex = (scratchIndex + 1) & 1023)
  })
})

summary(() => {
  bench('now() strategy: native BigInt return', () => do_not_optimize(binding.now()))
  bench('now() strategy: shared slot + read', () => do_not_optimize(nowViaSlot()))
})

await run()
