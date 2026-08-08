// Fails the release if the aggregated prebuilds are not exactly what should
// ship. Publishing a tarball that quietly lost one platform's binary is the
// classic native-addon release accident, and for this package it is worse than
// usual: the affected users get a hard load error, not a slow fallback.
//
// Beyond the file list, every binary's header is checked against the directory
// and libc tag its filename claims. The per-platform verify jobs test each
// artifact before the publish job merges six of them into one tree, so the
// merge itself is the one step nothing else watches: a path collision there
// would overwrite a good binary with one for the wrong architecture while
// keeping the right filename. Sixteen bytes of header reading closes that.
//
// The manifest is checked for the same reason: nothing this package ships may
// run on a consumer's machine at install time, and the way that promise breaks
// is silent (see the "files" check below).
//
// Usage: node scripts/verify-prebuilds.mjs [--expect-version <version>] [--root <dir>]

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { inspect } from './lib/hardening.mjs'
import { section } from './lib/changelog.mjs'

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
  'linux-arm64/nanoepoch.musl.node',
  'darwin-arm64/nanoepoch.node',
  'darwin-x64/nanoepoch.node'
]

// IMAGE_FILE_MACHINE_* for PE, e_machine for ELF, cputype for Mach-O.
const MACHINE = {
  'win32-x64': 0x8664,
  'win32-arm64': 0xAA64,
  'linux-x64': 62, // EM_X86_64
  'linux-arm64': 183, // EM_AARCH64
  'darwin-x64': 0x01000007, // CPU_TYPE_X86 | CPU_ARCH_ABI64
  'darwin-arm64': 0x0100000C // CPU_TYPE_ARM | CPU_ARCH_ABI64
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

  if (directory.startsWith('darwin-')) {
    // Mach-O: MH_MAGIC_64, then cputype. Both are stored little-endian on the
    // two architectures this ships for, so one read order covers both.
    const magic = data.length >= 8 ? data.readUInt32LE(0) : 0
    // A universal binary IS Mach-O, so reporting "not a Mach-O file" would send
    // the reader hunting for a corrupt build instead of the stray `lipo` that
    // actually produced it. The loader would accept one, but a fat file doubles
    // every macOS install to ship an architecture the directory already names.
    if (magic === 0xCAFEBABE || magic === 0xBEBAFECA) {
      problems.push(`universal (fat) binary: prebuilds/${relative}; each directory ships exactly one architecture`)
      return
    }
    if (magic !== 0xFEEDFACF) {
      problems.push(`not a Mach-O file: prebuilds/${relative}`)
      return
    }
    const cpuType = data.readUInt32LE(4)
    if (cpuType !== expectedMachine) {
      problems.push(`architecture mismatch: prebuilds/${relative} is cputype 0x${cpuType.toString(16)}, ` +
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

  // The libc claim in the filename, and everything else the linker was asked to
  // do, are checked together by reading the dynamic section -- see
  // checkHardening below. That covers the libc tag exactly (DT_NEEDED must be
  // the one libc and nothing else) rather than by the substring search this
  // used to do, which could not tell "links against glibc" from "happens to
  // contain that string somewhere".
}

// Everything binding.gyp asks the toolchain for and no functional test can see:
// RELRO, BIND_NOW, a stack canary, a non-executable stack, an exact DT_NEEDED
// set, the advertised glibc and macOS floors, Control Flow Guard on Windows,
// and that the binary was really stripped.
function checkHardening (relative) {
  const [directory, filename] = relative.split('/')
  const target = directory.startsWith('linux-')
    ? `${directory}-${filename.includes('.musl.') ? 'musl' : 'glibc'}`
    : directory

  let data
  try {
    data = readFileSync(join(root, 'prebuilds', directory, filename))
  } catch {
    return // already reported by checkContents
  }

  // skipMachine: checkContents has already compared the architecture against
  // the directory name, in the wording that names the merge accident it looks
  // for. Two reports of one fault read as two faults.
  const { problems: faults } = inspect(data, target, { skipMachine: true })
  for (const fault of faults) problems.push(`prebuilds/${relative}: ${fault}`)
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
    checkHardening(relative)
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

// Nothing in the tarball may execute on a consumer's machine, and the way that
// promise breaks is invisible: npm treats a binding.gyp in the root of an
// installed package as an implicit `node-gyp rebuild` whenever the package
// declares no install or preinstall of its own. Putting binding.gyp back into
// "files" would therefore reinstate install-time compilation with no script
// anywhere to point at. It stays in the REPOSITORY, where that same rule is
// what builds the addon for contributors -- it just must not be shipped.
for (const stage of ['preinstall', 'install', 'postinstall']) {
  const script = pkg.scripts?.[stage]
  if (script) {
    problems.push(`package.json declares a lifecycle script that runs on every consumer's machine (${stage}): ${script}`)
  }
}
// The half that 0.3.0 got wrong, and the reason 0.3.1 exists. Keeping
// binding.gyp out of "files" keeps it out of the TARBALL, but npm builds the
// manifest it uploads to the registry by running its own preparation over the
// PUBLISH DIRECTORY -- which is this repository, binding.gyp and all. That step
// sets gypfile: true and scripts.install = "node-gyp rebuild" on the published
// manifest whenever no install script is declared, so npm then runs node-gyp
// against a tarball that has no binding.gyp in it and every install fails.
// Declaring gypfile: false is what turns that preparation step off; verified
// against npm 11 and npm 12. The check is written against the file on disk
// rather than a constant so it disappears by itself if binding.gyp ever leaves
// the repository.
if (existsSync(join(packageRoot, 'binding.gyp')) && pkg.gypfile !== false) {
  problems.push('package.json must set "gypfile": false while binding.gyp is in the repository, ' +
    'or npm publishes a manifest with an implicit "install": "node-gyp rebuild" that the tarball cannot satisfy')
}

for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
  const normalised = entry.replace(/^\.\//, '')
  // Any bare *.gyp at the package root, not just the literal binding.gyp: npm's
  // manifest preparation globs "*.gyp" over the publish directory, so the rule
  // being defended here is wider than the one filename. (Install-time detection
  // itself does look only for binding.gyp -- but a gate that permits root
  // "other.gyp" is a gate that permits renaming the problem.) Nothing at the
  // root needs a .gyp extension; the auditable copy lives in build-recipe/,
  // which neither npm code path can see.
  if (/^[^/]+\.gyp$/.test(normalised)) {
    problems.push(`package.json "files" ships ${entry}; a *.gyp in the tarball root is what npm turns into an implicit node-gyp rebuild at install time`)
  } else if (normalised === 'scripts' || normalised.startsWith('scripts/')) {
    problems.push(`package.json "files" ships ${entry}; nothing under scripts/ is meant to reach a consumer`)
  } else if (normalised === 'test' || normalised.startsWith('test/')) {
    // One exact path, never the directory. `node --test` discovers everything
    // under test/ -- including files a future contributor adds as helpers or
    // fixtures, and including .ts -- so whitelisting the directory would run
    // whatever lands there on every consumer's machine.
    if (normalised !== 'test/smoke.test.mjs') {
      problems.push(`package.json "files" ships ${entry}; only test/smoke.test.mjs may ship, ` +
        'because node --test executes every file under test/ on a consumer\'s machine')
    }
  }
}

const expectVersionIndex = process.argv.indexOf('--expect-version')
const releasing = expectVersionIndex !== -1
if (releasing) {
  const expected = process.argv[expectVersionIndex + 1]?.replace(/^v/, '')
  if (expected && expected !== pkg.version) {
    problems.push(`tag says ${expected} but package.json says ${pkg.version}`)
  }

  // The GitHub release notes are cut from this section. Checking it here, before
  // publish, is what stops a missing entry from being discovered by the job that
  // runs after the package is already on the registry and cannot be recalled.
  // Same extraction the release job uses, so the two cannot disagree about what
  // counts as a section.
  try {
    const changelog = readFileSync(join(packageRoot, 'CHANGELOG.md'), 'utf8')
    if (section(changelog, pkg.version) === null) {
      problems.push(`CHANGELOG.md has no "## ${pkg.version}" section; the release notes are cut from it`)
    }
  } catch (error) {
    problems.push(`CHANGELOG.md is missing or unreadable (${error.message})`)
  }
}

// The lockfile is what makes `npm ci` reproduce a build. If it has drifted from
// the manifest, every build container silently resolves its own node-gyp and
// the recorded compiler-of-record in BUILD-INFO.json stops meaning anything.
try {
  const lock = require(join(packageRoot, 'package-lock.json'))
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    problems.push(`package-lock.json says ${lock.version} but package.json says ${pkg.version}; run npm install to resync`)
  }
} catch (error) {
  problems.push(`package-lock.json is missing or unreadable (${error.message}); npm ci cannot run without it`)
}

// BUILD-INFO.json records what each build job produced: the sha256 of every
// binary and the hash of the source it was compiled from. Re-checking it here
// covers the one step no per-platform job can see -- the merge of six artifact
// downloads into one tree, where a path collision keeps the right filename and
// the wrong bytes.
//
// Required only when releasing. A contributor running `npm pack` or
// prepublishOnly locally has no build-info to merge, and should not be told
// their checkout is broken; but if the file IS present it is always checked in
// full, so a stale one cannot pass by being ignored.
function checkBuildInfo () {
  const file = join(root, 'BUILD-INFO.json')
  if (!existsSync(file)) {
    if (releasing) {
      problems.push('BUILD-INFO.json is missing; run `node scripts/build-info.mjs --merge` after downloading the build-info artifacts')
    }
    return
  }

  let info
  try {
    info = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    problems.push(`BUILD-INFO.json is unreadable: ${error.message}`)
    return
  }

  if (info.version !== pkg.version) {
    problems.push(`BUILD-INFO.json describes ${info.version} but this is ${pkg.version}`)
  }

  const recorded = new Map()
  for (const binary of Array.isArray(info.binaries) ? info.binaries : []) {
    if (typeof binary?.path === 'string') recorded.set(binary.path, binary)
  }

  for (const relative of EXPECTED) {
    const key = `prebuilds/${relative}`
    const binary = recorded.get(key)
    if (!binary) {
      problems.push(`BUILD-INFO.json has no record for ${key}`)
      continue
    }
    let bytes
    try {
      bytes = readFileSync(join(root, 'prebuilds', relative))
    } catch {
      continue // already reported as missing or unreadable above
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== binary.sha256) {
      problems.push(`${key} hashes to ${actual} but BUILD-INFO.json records ${binary.sha256}`)
    }
    if (binary.size !== bytes.length) {
      problems.push(`${key} is ${bytes.length} bytes but BUILD-INFO.json records ${binary.size}`)
    }
  }

  for (const key of recorded.keys()) {
    if (!EXPECTED.includes(key.replace(/^prebuilds\//, ''))) {
      problems.push(`BUILD-INFO.json records ${key}, which is not in the support matrix`)
    }
  }

  // Two identical hashes means one build's output landed on top of another's.
  const seen = new Map()
  for (const binary of recorded.values()) {
    if (seen.has(binary.sha256)) {
      problems.push(`${binary.path} and ${seen.get(binary.sha256)} are byte-identical, so one build overwrote the other`)
    } else {
      seen.set(binary.sha256, binary.path)
    }
  }

  // The tarball ships src/nanoepoch.c and build-recipe/binding.gyp so the
  // binaries can be rebuilt from what the consumer received. That only means
  // anything if the shipped source is the source they were built from.
  for (const [relative, expectedHash] of Object.entries(info.source ?? {})) {
    let actual
    try {
      actual = createHash('sha256').update(readFileSync(join(packageRoot, relative))).digest('hex')
    } catch (error) {
      problems.push(`BUILD-INFO.json records a hash for ${relative}, which cannot be read (${error.message})`)
      continue
    }
    if (actual !== expectedHash) {
      problems.push(`${relative} hashes to ${actual} but the binaries were built from ${expectedHash}`)
    }
  }
  if (releasing && !info.source) {
    problems.push('BUILD-INFO.json carries no "source" block, so nothing ties the shipped source to the binaries')
  }
}

checkBuildInfo()

if (problems.length > 0) {
  console.error(`refusing to publish nanoepoch@${pkg.version}:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nfound:')
  for (const [relative, size] of [...found].sort()) console.error(`  prebuilds/${relative} (${size} bytes)`)
  process.exit(1)
}

// stderr, like every other line this script writes. It runs as prepublishOnly,
// and npm's --json modes use stdout as a data channel: `npm publish --dry-run
// --json > file` puts whatever a lifecycle script printed at the top of that
// file, ahead of the JSON. The release's own dry-run check parses exactly that
// file, so a success message on stdout failed the release by announcing that
// everything was fine.
console.error(`nanoepoch@${pkg.version}: all ${EXPECTED.length} prebuilds present, architectures and libc links verified`)
for (const relative of EXPECTED) console.error(`  prebuilds/${relative} (${found.get(relative)} bytes)`)
