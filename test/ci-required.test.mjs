// The branch ruleset requires exactly one check, `ci-required`, which waits on
// every other gating job in ci.yml. That collapses 27 expanded matrix names
// into one stable entry, and it moves the definition of "what must pass" out of
// the ruleset -- which only an administrator can edit -- and into a file a pull
// request can change.
//
// That move is the reason this test exists. Removing a job from the ruleset
// fails closed: the check never reports and nothing can merge. Removing a job
// from ci-required's `needs:` fails OPEN, silently, and the only thing that
// would otherwise catch it is someone noticing the line in a diff.
//
// ci.yml is read as text rather than parsed: this package has two development
// dependencies, and adding a YAML parser to assert one list is a worse trade
// than a strict reader over a file whose shape is fixed by the workflow schema.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluate } from '../scripts/lib/ci-required.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(join(packageRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
const lines = workflow.split(/\r?\n/)

// Top-level jobs are the only keys at exactly two spaces of indentation after
// the `jobs:` line, and each job's body is everything up to the next one.
function readJobs (text) {
  const source = text.split(/\r?\n/)
  const start = source.findIndex((line) => line === 'jobs:')
  assert.notEqual(start, -1, 'ci.yml has no jobs: block')

  const jobs = new Map()
  let current = null
  for (const line of source.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (header) {
      current = header[1]
      jobs.set(current, [])
      continue
    }
    if (/^\S/.test(line) && line.trim() !== '') break // left the jobs block
    if (current) jobs.get(current).push(line)
  }
  return jobs
}

const jobs = readJobs(workflow)

// The `needs:` list of a job, in its block form. ci-required is written that
// way on purpose -- one job per line reviews better than a flow sequence.
function needsOf (job) {
  const body = jobs.get(job)
  assert.ok(body, `ci.yml has no job called ${job}`)
  const start = body.findIndex((line) => line.trim() === 'needs:')
  if (start === -1) return []
  const collected = []
  for (const line of body.slice(start + 1)) {
    const item = /^ {6}- ([A-Za-z0-9_-]+)\s*$/.exec(line)
    if (!item) break
    collected.push(item[1])
  }
  return collected
}

// Job-level `continue-on-error` only, which is four spaces in. A STEP may also
// carry one -- clock-step lets the benchmark fail without failing the job --
// and that says nothing about whether the job gates a merge. Matching on the
// indentation is what keeps the two apart.
function isNonGating (job) {
  return jobs.get(job).some((line) => /^ {4}continue-on-error:\s*true\s*$/.test(line))
}

test('ci.yml parses into the jobs this test expects to find', () => {
  // A guard on the reader itself: if the extraction silently returned nothing,
  // every assertion below would pass vacuously.
  assert.ok(jobs.size >= 10, `only found ${jobs.size} jobs: ${[...jobs.keys()].join(', ')}`)
  assert.ok(jobs.has('ci-required'), 'ci.yml has no ci-required job')
  assert.ok(jobs.has('runtime-smoke'), 'ci.yml has no runtime-smoke job')
})

test('ci-required waits on every gating job', () => {
  // The whole point. A job added to CI but not to this list runs, reports, and
  // gates nothing -- the pull request that adds it goes green either way.
  const gating = [...jobs.keys()].filter((job) => job !== 'ci-required' && !isNonGating(job))
  assert.deepEqual(needsOf('ci-required').sort(), gating.sort(),
    'ci-required.needs must be every job except itself and the non-gating ones, ' +
    'or the branch ruleset stops covering what it looks like it covers')
})

test('ci-required does not wait on a job that is allowed to fail', () => {
  // continue-on-error jobs report success to `needs` whatever they did, so
  // listing one would not break the gate -- it would just claim coverage that
  // does not exist.
  for (const job of needsOf('ci-required')) {
    assert.equal(isNonGating(job), false,
      `${job} is continue-on-error, so requiring it asserts nothing`)
  }
})

test('ci-required runs even when a job it waits on failed', () => {
  // Without `if: always()` a failed dependency SKIPS this job, and GitHub
  // reports a skipped job to branch protection as a success. The gate would go
  // green exactly when CI is red, which is the worst available failure.
  const body = jobs.get('ci-required')
  assert.ok(body.some((line) => line.trim() === 'if: always()'),
    'ci-required needs `if: always()` or a failed dependency turns the gate green')
})

test('ci-required rejects every result that is not success', () => {
  // The load-bearing case is "skipped". Three of the gating jobs sit behind
  // `needs: prebuild-linux-x64`, so a failure there skips them -- and branch
  // protection reads a skipped required check as a PASS. A gate that only
  // looked for "failure" would go green in exactly the situation it exists for.
  for (const result of ['failure', 'skipped', 'cancelled', 'missing']) {
    const { failed } = evaluate({ types: { result: 'success' }, test: { result } })
    assert.deepEqual(failed.map((job) => job.name), ['test'],
      `a job reported as "${result}" must fail the gate`)
  }

  const { failed } = evaluate({ types: { result: 'success' }, test: { result: 'success' } })
  assert.deepEqual(failed, [], 'all-success must pass the gate')
})

test('ci-required names every job that did not succeed, not just the first', () => {
  // The output is the only diagnosis a maintainer gets from the merge box.
  const { failed } = evaluate({
    test: { result: 'failure' },
    types: { result: 'success' },
    'install-proof': { result: 'skipped' }
  })
  assert.deepEqual(failed.map((job) => job.name).sort(), ['install-proof', 'test'])
})

test('the workflow runs the script this test exercises', () => {
  // Without this, the test could pass against a script the workflow no longer
  // calls -- which is how the inline version went unverified in the first place.
  const body = jobs.get('ci-required').join('\n')
  assert.match(body, /run: node scripts\/ci-required\.mjs/,
    'ci-required must run scripts/ci-required.mjs, the file these assertions cover')
  assert.match(body, /RESULTS: \$\{\{ toJSON\(needs\) \}\}/,
    'the script reads the needs context from RESULTS, so the workflow must set it')
})

test('the ruleset entry name is spelled the way the ruleset expects', () => {
  // The ruleset matches on the job's display name. Renaming it here removes the
  // gate without any error anywhere: the required check simply stops reporting,
  // and a required check that never reports blocks merges until someone edits
  // the ruleset.
  assert.ok(jobs.get('ci-required').some((line) => line.trim() === 'name: ci-required'),
    'the branch ruleset requires a check literally called "ci-required"')
})

test('every job in the workflow is either gating or explicitly not', () => {
  // Catches the third state: a job that is neither in ci-required's needs nor
  // marked continue-on-error is one nobody decided about.
  const needs = new Set(needsOf('ci-required'))
  const undecided = [...jobs.keys()].filter(
    (job) => job !== 'ci-required' && !needs.has(job) && !isNonGating(job))
  assert.deepEqual(undecided, [],
    'these jobs gate nothing and are not marked continue-on-error: ' + undecided.join(', '))
})

test('the release workflow is not accidentally covered by this gate', () => {
  // ci-required is about ci.yml. release.yml runs on tags, has its own gates,
  // and must not be reachable from a branch ruleset that could be satisfied by
  // a pull request.
  assert.ok(!lines.some((line) => line.includes('release.yml')),
    'ci.yml should not reference release.yml')
})
