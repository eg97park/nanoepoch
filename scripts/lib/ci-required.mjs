// The decision ci.yml's `ci-required` job makes: given the results of every
// gating job, did CI pass?
//
// It is a file, and not a `node -e` inside the workflow, because this is the
// one check standing between a red CI and a merged pull request, and logic
// buried in YAML inside a shell string cannot be tested -- the same reason
// lib/changelog.mjs exists.

// GitHub reports four results for a job: success, failure, cancelled, skipped.
// Anything that is not success fails the gate, and SKIPPED is why this is
// written as "not success" rather than as a search for "failure":
//
//   - A job whose `needs:` dependency failed is SKIPPED, not failed. Three of
//     this workflow's gating jobs sit behind `needs: prebuild-linux-x64`, so it
//     is a state they genuinely reach.
//   - Branch protection reads a skipped required check as a PASS.
//
// Together those mean a gate that only looked for "failure" would go green in
// exactly the situation it exists to catch.
export function evaluate (needs) {
  const jobs = Object.entries(needs).map(([name, value]) => ({
    name,
    // A job present in `needs` but carrying no result is a shape this code does
    // not understand, and the safe reading of "I do not understand" is "no".
    result: value?.result ?? 'missing'
  }))
  jobs.sort((a, b) => a.name.localeCompare(b.name))

  return {
    jobs,
    failed: jobs.filter((job) => job.result !== 'success')
  }
}
