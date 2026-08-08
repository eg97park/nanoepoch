// Merges the per-binary records that scripts/prebuild.mjs leaves in build-info/
// into the single BUILD-INFO.json that ships inside the npm tarball.
//
// What this exists to prove, in order of how likely each is to go wrong:
//
//   1. All eight binaries were compiled from the SAME source. Six build jobs
//      check out the same commit, but nothing else compares what they actually
//      fed to the compiler, and the tarball ships one copy of src/nanoepoch.c
//      for all eight of them. If those disagree, the shipped source describes
//      at most one of the binaries next to it.
//   2. The eight binaries are eight DIFFERENT files. The release gate reads
//      each one's header, but linux-x64 glibc and musl share a machine type,
//      and a merge that dropped one artifact on top of the other would keep
//      both filenames.
//   3. Every record names a binary the support matrix expects, and every
//      expected binary has a record.
//
// The hashes themselves are then re-checked against the bytes on disk by
// scripts/verify-prebuilds.mjs, after the six artifacts are merged into one
// tree -- the merge being the one step no per-platform job can watch.
//
// Usage: node scripts/build-info.mjs --merge [--root <dir>]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const rootFlag = process.argv.indexOf('--root')
const root = rootFlag === -1 ? packageRoot : process.argv[rootFlag + 1]
if (rootFlag !== -1 && !root) {
  console.error('build-info: --root requires a directory')
  process.exit(1)
}

if (!process.argv.includes('--merge')) {
  console.error('usage: node scripts/build-info.mjs --merge [--root <dir>]')
  process.exit(1)
}

const pkg = require(join(packageRoot, 'package.json'))

// The same eight rows as the published support matrix, and the same list
// scripts/verify-prebuilds.mjs enforces. Kept in both places on purpose: this
// one is about what the BUILD JOBS produced, that one about what is on disk at
// publish time, and a bug that makes them agree wrongly needs to be written
// twice.
const EXPECTED = [
  'prebuilds/win32-x64/nanoepoch.node',
  'prebuilds/win32-arm64/nanoepoch.node',
  'prebuilds/linux-x64/nanoepoch.glibc.node',
  'prebuilds/linux-x64/nanoepoch.musl.node',
  'prebuilds/linux-arm64/nanoepoch.glibc.node',
  'prebuilds/linux-arm64/nanoepoch.musl.node',
  'prebuilds/darwin-arm64/nanoepoch.node',
  'prebuilds/darwin-x64/nanoepoch.node'
]

const problems = []
const records = []

const infoDir = join(root, 'build-info')
let entries
try {
  entries = readdirSync(infoDir).filter((entry) => entry.endsWith('.json')).sort()
} catch {
  console.error(`build-info: ${infoDir} does not exist; the build jobs produced no records`)
  process.exit(1)
}

for (const entry of entries) {
  try {
    records.push({ file: entry, ...JSON.parse(readFileSync(join(infoDir, entry), 'utf8')) })
  } catch (error) {
    problems.push(`unreadable record build-info/${entry}: ${error.message}`)
  }
}

const byPath = new Map()
for (const record of records) {
  if (typeof record.path !== 'string' || typeof record.sha256 !== 'string') {
    problems.push(`build-info/${record.file} is missing "path" or "sha256"`)
    continue
  }
  if (byPath.has(record.path)) {
    problems.push(`two records claim ${record.path}: build-info/${byPath.get(record.path).file} and build-info/${record.file}`)
    continue
  }
  byPath.set(record.path, record)
}

for (const path of EXPECTED) {
  if (!byPath.has(path)) problems.push(`no build-info record for ${path}`)
}
for (const path of byPath.keys()) {
  if (!EXPECTED.includes(path)) {
    problems.push(`build-info record for ${path}, which is not in the support matrix`)
  }
}

// Two binaries with the same hash means one build's output was copied over
// another's -- the artifact-merge accident that keeps both filenames and would
// otherwise reach a consumer as "the wrong libc, correctly named".
const byHash = new Map()
for (const record of byPath.values()) {
  const seen = byHash.get(record.sha256)
  if (seen) problems.push(`${record.path} and ${seen} are byte-identical, so one build overwrote the other`)
  else byHash.set(record.sha256, record.path)
}

// Every job compiled the same commit, so every job must have hashed the same
// sources. Disagreement here means the tarball's src/nanoepoch.c is not what
// some of the shipped binaries were built from.
const sources = [...byPath.values()].map((record) => ({ path: record.path, source: record.source }))
const reference = sources.find((entry) => entry.source)
if (!reference) {
  if (records.length > 0) problems.push('no record carries a "source" block, so nothing ties the binaries to the shipped source')
} else {
  for (const entry of sources) {
    if (JSON.stringify(entry.source) !== JSON.stringify(reference.source)) {
      problems.push(`${entry.path} was built from different sources than ${reference.path}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`build-info: refusing to write BUILD-INFO.json for nanoepoch@${pkg.version}:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const first = [...byPath.values()][0]
const merged = {
  schemaVersion: 1,
  name: pkg.name,
  version: pkg.version,
  source: reference.source,
  builtBy: {
    sha: first.ci?.sha ?? null,
    runId: first.ci?.runId ?? null,
    workflowRef: first.ci?.workflowRef ?? null
  },
  binaries: EXPECTED.map((path) => {
    const { file, version, ...record } = byPath.get(path)
    return record
  })
}

const out = join(root, 'BUILD-INFO.json')
writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`)

console.log(`build-info: ${out}`)
for (const binary of merged.binaries) console.log(`  ${binary.path} ${binary.sha256}`)
