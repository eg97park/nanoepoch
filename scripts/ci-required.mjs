// The body of ci.yml's `ci-required` job -- the single check the branch ruleset
// requires. It passes only when every gating CI job succeeded.
//
// The workflow hands over the results in RESULTS as `${{ toJSON(needs) }}`,
// because a job cannot ask GitHub for its own dependencies. The decision itself
// is in lib/ so the test suite can exercise it against every result GitHub can
// report; see test/ci-required.test.mjs.

import { evaluate } from './lib/ci-required.mjs'

const raw = process.env.RESULTS
if (raw === undefined) {
  console.error('ci-required: RESULTS is unset; the workflow must pass ${{ toJSON(needs) }}')
  process.exit(1)
}

let needs
try {
  needs = JSON.parse(raw)
} catch (error) {
  console.error(`ci-required: RESULTS is not JSON (${error.message})`)
  process.exit(1)
}

// An empty list would be a gate that passes because it checked nothing.
if (!needs || typeof needs !== 'object' || Object.keys(needs).length === 0) {
  console.error('ci-required: no jobs to check, so this gate would assert nothing')
  process.exit(1)
}

const { jobs, failed } = evaluate(needs)
for (const job of jobs) console.log(`${job.result.padEnd(10)}${job.name}`)

if (failed.length > 0) {
  console.error('\nFAILED: these required jobs did not succeed:')
  for (const job of failed) console.error(`  ${job.name}: ${job.result}`)
  process.exit(1)
}

console.log(`\nok: all ${jobs.length} required jobs succeeded`)
