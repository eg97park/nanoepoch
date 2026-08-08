// scripts/build-info.mjs merges eight per-binary records, one written by each
// build job, into the BUILD-INFO.json that ships in the tarball. It is the only
// thing that sees all eight jobs' output at once, so it is where the accidents
// that no single job can notice have to be caught: an artifact download that
// overwrote another, a job that compiled a different source, a target that
// silently produced nothing.
//
// Every case here is synthetic JSON. That is deliberate -- these assertions are
// about the merge logic, not about binaries, so they run on a fresh clone with
// no prebuilds present, unlike the real-tree cases in release-guard.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(packageRoot, 'scripts', 'build-info.mjs')

const TARGETS = [
  ['win32-x64', 'nanoepoch.node', null],
  ['win32-arm64', 'nanoepoch.node', null],
  ['linux-x64', 'nanoepoch.glibc.node', 'glibc'],
  ['linux-x64', 'nanoepoch.musl.node', 'musl'],
  ['linux-arm64', 'nanoepoch.glibc.node', 'glibc'],
  ['linux-arm64', 'nanoepoch.musl.node', 'musl'],
  ['darwin-arm64', 'nanoepoch.node', null],
  ['darwin-x64', 'nanoepoch.node', null]
]

const SOURCE = { 'src/nanoepoch.c': 'a'.repeat(64), 'binding.gyp': 'b'.repeat(64) }

const fixtures = []

test.after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

// `edit` receives the eight records keyed by their sidecar filename, so a case
// can corrupt exactly one of them the way one misbehaving job would.
function makeRecords (edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'nanoepoch-buildinfo-'))
  fixtures.push(root)
  mkdirSync(join(root, 'build-info'))

  const records = {}
  TARGETS.forEach(([target, file, libc], index) => {
    records[`${target}${libc ? `.${libc}` : ''}.json`] = {
      path: `prebuilds/${target}/${file}`,
      sha256: String(index).repeat(64),
      size: 1000 + index,
      platform: target.split('-')[0],
      arch: target.split('-')[1],
      libc,
      source: { ...SOURCE },
      build: { node: 'v24.19.0', napi: '10', nodeGyp: '13.0.1', compiler: 'test' },
      ci: { sha: 'deadbeef', runId: '1', workflowRef: 'eg97park/nanoepoch/.github/workflows/release.yml@refs/tags/v0.3.1' },
      version: '0.3.1'
    }
  })

  edit(records)

  for (const [name, record] of Object.entries(records)) {
    writeFileSync(join(root, 'build-info', name), JSON.stringify(record, null, 2))
  }
  return root
}

function merge (root) {
  const result = spawnSync(process.execPath, [script, '--merge', '--root', root], { encoding: 'utf8' })
  return { status: result.status, out: result.stdout + result.stderr }
}

test('eight consistent records merge into one manifest', () => {
  const root = makeRecords()
  const { status, out } = merge(root)
  assert.equal(status, 0, out)

  const info = JSON.parse(readFileSync(join(root, 'BUILD-INFO.json'), 'utf8'))
  assert.equal(info.schemaVersion, 1)
  assert.equal(info.name, 'nanoepoch')
  assert.deepEqual(info.source, SOURCE)
  assert.equal(info.binaries.length, 8)
  // Sorted into support-matrix order rather than readdir order, so the file is
  // stable across the platforms that merge it.
  assert.deepEqual(info.binaries.map((binary) => binary.path), [
    'prebuilds/win32-x64/nanoepoch.node',
    'prebuilds/win32-arm64/nanoepoch.node',
    'prebuilds/linux-x64/nanoepoch.glibc.node',
    'prebuilds/linux-x64/nanoepoch.musl.node',
    'prebuilds/linux-arm64/nanoepoch.glibc.node',
    'prebuilds/linux-arm64/nanoepoch.musl.node',
    'prebuilds/darwin-arm64/nanoepoch.node',
    'prebuilds/darwin-x64/nanoepoch.node'
  ])
})

test('a target whose build job produced nothing is named', () => {
  const root = makeRecords((records) => {
    delete records['darwin-x64.json']
  })
  const { status, out } = merge(root)
  assert.equal(status, 1)
  assert.match(out, /no build-info record for prebuilds\/darwin-x64\/nanoepoch\.node/)
})

test('two binaries with the same bytes mean one artifact overwrote another', () => {
  // The merge accident the per-platform verify jobs cannot see: linux-x64
  // glibc and musl share an ELF machine type, so a collision keeps the right
  // filename and the wrong contents, and every header check still passes.
  const root = makeRecords((records) => {
    records['linux-x64.musl.json'].sha256 = records['linux-x64.glibc.json'].sha256
  })
  const { status, out } = merge(root)
  assert.equal(status, 1)
  assert.match(out, /byte-identical, so one build overwrote the other/)
})

test('a job that compiled a different source is refused', () => {
  // The tarball ships one src/nanoepoch.c for all eight binaries. If the jobs
  // disagree about what they compiled, that file describes at most one of them.
  const root = makeRecords((records) => {
    records['linux-arm64.musl.json'].source['src/nanoepoch.c'] = 'c'.repeat(64)
  })
  const { status, out } = merge(root)
  assert.equal(status, 1)
  assert.match(out, /was built from different sources than/)
})

test('a record for a target outside the support matrix is refused', () => {
  const root = makeRecords((records) => {
    records['freebsd-x64.json'] = {
      ...records['linux-x64.glibc.json'],
      path: 'prebuilds/freebsd-x64/nanoepoch.node',
      sha256: 'f'.repeat(64)
    }
  })
  const { status, out } = merge(root)
  assert.equal(status, 1)
  assert.match(out, /prebuilds\/freebsd-x64\/nanoepoch\.node, which is not in the support matrix/)
})

test('a malformed record is reported rather than crashing the merge', () => {
  const root = makeRecords((records) => {
    delete records['win32-arm64.json'].sha256
  })
  const { status, out } = merge(root)
  assert.equal(status, 1)
  assert.match(out, /is missing "path" or "sha256"/)
  assert.doesNotMatch(out, /at Object\.<anonymous>/, 'a bad record should be a named refusal, not a stack trace')
})
