// Fails the release if the aggregated prebuilds are not exactly what should
// ship. Publishing a tarball that quietly lost one platform's binary is the
// classic native-addon release accident, and for this package it is worse than
// usual: the affected users get a hard load error, not a slow fallback.
//
// Usage: node scripts/verify-prebuilds.mjs [--expect-version <version>]

import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = require(join(packageRoot, 'package.json'))

// One entry per row of the published support matrix.
const EXPECTED = [
  'win32-x64/nanoepoch.node',
  'win32-arm64/nanoepoch.node',
  'linux-x64/nanoepoch.glibc.node',
  'linux-x64/nanoepoch.musl.node',
  'linux-arm64/nanoepoch.glibc.node',
  'linux-arm64/nanoepoch.musl.node'
]

const problems = []

function listPrebuilds () {
  const root = join(packageRoot, 'prebuilds')
  const found = new Map()
  let directories
  try {
    directories = readdirSync(root)
  } catch {
    problems.push('prebuilds/ does not exist; the build jobs produced nothing')
    return found
  }
  for (const directory of directories) {
    for (const file of readdirSync(join(root, directory))) {
      if (!file.endsWith('.node')) continue
      const relative = `${directory}/${file}`
      found.set(relative, statSync(join(root, directory, file)).size)
    }
  }
  return found
}

const found = listPrebuilds()

for (const relative of EXPECTED) {
  const size = found.get(relative)
  if (size === undefined) {
    problems.push(`missing prebuild: prebuilds/${relative}`)
  } else if (size < 4096) {
    problems.push(`suspiciously small prebuild (${size} bytes): prebuilds/${relative}`)
  }
}

for (const relative of found.keys()) {
  if (!EXPECTED.includes(relative)) {
    problems.push(`unexpected prebuild, so the support matrix and the build jobs disagree: prebuilds/${relative}`)
  }
}

// The repository field must be real: npm provenance verifies it against the
// publishing workflow's repository.
const repositoryUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
if (!repositoryUrl || repositoryUrl.includes('CHANGEME')) {
  problems.push(`package.json repository is still a placeholder: ${repositoryUrl}`)
}

const expectVersionIndex = process.argv.indexOf('--expect-version')
if (expectVersionIndex !== -1) {
  const expected = process.argv[expectVersionIndex + 1]?.replace(/^v/, '')
  if (expected && expected !== pkg.version) {
    problems.push(`tag says ${expected} but package.json says ${pkg.version}`)
  }
}

if (problems.length > 0) {
  console.error(`refusing to publish nanoepoch@${pkg.version}:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nfound:')
  for (const [relative, size] of [...found].sort()) console.error(`  prebuilds/${relative} (${size} bytes)`)
  process.exit(1)
}

console.log(`nanoepoch@${pkg.version}: all ${EXPECTED.length} prebuilds present`)
for (const relative of EXPECTED) console.log(`  prebuilds/${relative} (${found.get(relative)} bytes)`)
