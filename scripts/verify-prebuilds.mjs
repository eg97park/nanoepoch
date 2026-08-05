// Fails the release if the aggregated prebuilds are not exactly what should
// ship. Publishing a tarball that quietly lost one platform's binary is the
// classic native-addon release accident, and for this package it is worse than
// usual: the affected users get a hard load error, not a slow fallback.
//
// Beyond the file list, every binary's header is checked against the directory
// and libc tag its filename claims. The per-platform verify jobs test each
// artifact before the publish job merges four of them into one tree, so the
// merge itself is the one step nothing else watches: a path collision there
// would overwrite a good binary with one for the wrong architecture while
// keeping the right filename. Sixteen bytes of header reading closes that.
//
// Usage: node scripts/verify-prebuilds.mjs [--expect-version <version>] [--root <dir>]

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// --root exists for the tests, which build deliberately wrong trees in a temp
// directory. package.json is always read from the real package root: the tests
// are about binaries, not about manifests.
const rootFlag = process.argv.indexOf('--root')
const root = rootFlag === -1 ? packageRoot : process.argv[rootFlag + 1]
if (rootFlag !== -1 && !root) {
  console.error('verify-prebuilds: --root requires a directory')
  process.exit(1)
}

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

// IMAGE_FILE_MACHINE_* for PE, e_machine for ELF.
const MACHINE = {
  'win32-x64': 0x8664,
  'win32-arm64': 0xAA64,
  'linux-x64': 62, // EM_X86_64
  'linux-arm64': 183 // EM_AARCH64
}

const problems = []

function listPrebuilds () {
  const prebuildsRoot = join(root, 'prebuilds')
  const found = new Map()
  let entries
  try {
    entries = readdirSync(prebuildsRoot)
  } catch {
    problems.push('prebuilds/ does not exist; the build jobs produced nothing')
    return found
  }
  for (const entry of entries) {
    // A stray file at this level (.DS_Store, a misplaced .node) is a report,
    // not a crash: readdirSync on it would throw ENOTDIR and turn a precise
    // refusal into a stack trace.
    let children
    try {
      children = statSync(join(prebuildsRoot, entry)).isDirectory()
        ? readdirSync(join(prebuildsRoot, entry))
        : null
    } catch {
      children = null
    }
    if (children === null) {
      problems.push(`unexpected non-directory entry: prebuilds/${entry}`)
      continue
    }
    for (const file of children) {
      if (!file.endsWith('.node')) continue
      const relative = `${entry}/${file}`
      found.set(relative, statSync(join(prebuildsRoot, entry, file)).size)
    }
  }
  return found
}

// The directory name claims a platform and architecture; the filename claims a
// libc. Check both claims against the bytes.
function checkContents (relative) {
  const [directory, filename] = relative.split('/')
  const expectedMachine = MACHINE[directory]
  if (expectedMachine === undefined) return // already reported as unexpected

  let data
  try {
    data = readFileSync(join(root, 'prebuilds', directory, filename))
  } catch (error) {
    problems.push(`unreadable prebuild: prebuilds/${relative} (${error.message})`)
    return
  }

  if (directory.startsWith('win32-')) {
    // PE: 'MZ', e_lfanew at 0x3C points at 'PE\0\0', machine follows it.
    if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5A4D) {
      problems.push(`not a PE file: prebuilds/${relative}`)
      return
    }
    const peOffset = data.readUInt32LE(0x3C)
    if (peOffset + 6 > data.length || data.readUInt32LE(peOffset) !== 0x00004550) {
      problems.push(`corrupt PE header: prebuilds/${relative}`)
      return
    }
    const machine = data.readUInt16LE(peOffset + 4)
    if (machine !== expectedMachine) {
      problems.push(`architecture mismatch: prebuilds/${relative} is machine 0x${machine.toString(16)}, ` +
        `but ${directory} requires 0x${expectedMachine.toString(16)}`)
    }
    return
  }

  // ELF: magic, then e_machine at offset 18.
  if (data.length < 20 || data.readUInt32BE(0) !== 0x7F454C46) {
    problems.push(`not an ELF file: prebuilds/${relative}`)
    return
  }
  const machine = data.readUInt16LE(18)
  if (machine !== expectedMachine) {
    problems.push(`architecture mismatch: prebuilds/${relative} is e_machine ${machine}, ` +
      `but ${directory} requires ${expectedMachine}`)
  }

  // The libc the binary was really linked against shows up as its DT_NEEDED
  // strings: the musl builds name libc.musl-<arch>.so.1 and nothing else, the
  // glibc builds name libc.so.6. A filename tag that contradicts the strings
  // means the loader will hand this binary to the wrong libc at require time.
  const wantsMusl = filename.includes('.musl.')
  const referencesMusl = data.includes('libc.musl-')
  const referencesGlibc = data.includes('libc.so.6')
  if (wantsMusl && (!referencesMusl || referencesGlibc)) {
    problems.push(`libc mismatch: prebuilds/${relative} is tagged musl but is linked against glibc`)
  } else if (!wantsMusl && (!referencesGlibc || referencesMusl)) {
    problems.push(`libc mismatch: prebuilds/${relative} is tagged glibc but is linked against musl`)
  }
}

const found = listPrebuilds()

for (const relative of EXPECTED) {
  const size = found.get(relative)
  if (size === undefined) {
    problems.push(`missing prebuild: prebuilds/${relative}`)
  } else if (size < 4096) {
    problems.push(`suspiciously small prebuild (${size} bytes): prebuilds/${relative}`)
  } else {
    checkContents(relative)
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

console.log(`nanoepoch@${pkg.version}: all ${EXPECTED.length} prebuilds present, architectures and libc links verified`)
for (const relative of EXPECTED) console.log(`  prebuilds/${relative} (${found.get(relative)} bytes)`)
