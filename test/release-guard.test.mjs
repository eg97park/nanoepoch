// scripts/verify-prebuilds.mjs is the last gate before npm publish, and the
// only one that sees the prebuilds AFTER the four platform artifacts are merged
// into one tree. These tests feed it deliberately wrong trees -- every binary a
// real one from this checkout, every corruption one a broken merge could
// produce -- and assert it refuses each with a message naming the actual fault.
//
// Skipped wholesale when the checkout does not carry all eight prebuilds, which
// is the normal state right after clone: the fixtures are built by cross-
// planting real binaries between directories, so all of them have to exist.
// The Mach-O and tarball tests below are built from synthesised bytes instead
// and run everywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(packageRoot, 'scripts', 'verify-prebuilds.mjs')

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

const haveAll = EXPECTED.every((relative) => existsSync(join(packageRoot, 'prebuilds', relative)))
const skip = haveAll ? false : 'needs all eight prebuilds (a release checkout); run the release build first'

const fixtures = []

// Start from a correct tree of real binaries, then let the test break it.
function makeTree (mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'nanoepoch-guard-'))
  fixtures.push(root)
  for (const relative of EXPECTED) {
    const target = join(root, 'prebuilds', ...relative.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(packageRoot, 'prebuilds', relative), target)
  }
  mutate(join(root, 'prebuilds'))
  return root
}

function run (root) {
  const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
  return { status: result.status, out: result.stdout + result.stderr }
}

// Some cases run the gate from a synthetic package root, so that its own
// package.json is the one under test. The gate imports scripts/lib/, so a copy
// of the script alone would fail to resolve rather than report the manifest
// fault the test is about.
function installGate (root) {
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  copyFileSync(script, join(root, 'scripts', 'verify-prebuilds.mjs'))
  for (const name of readdirSync(join(packageRoot, 'scripts', 'lib'))) {
    copyFileSync(join(packageRoot, 'scripts', 'lib', name), join(root, 'scripts', 'lib', name))
  }
}

test.after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

test('a correct tree of real binaries passes', { skip }, () => {
  const { status, out } = run(makeTree())
  assert.equal(status, 0, out)
  assert.match(out, /architectures and libc links verified/)
})

test('an arm64 binary hiding under an x64 name is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'linux-arm64', 'nanoepoch.glibc.node'),
      join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1, 'a wrong-architecture binary must fail the release')
  assert.match(out, /architecture mismatch: prebuilds\/linux-x64\/nanoepoch\.glibc\.node/)
})

test('a wrong-architecture Windows binary is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'win32-x64', 'nanoepoch.node'),
      join(prebuilds, 'win32-arm64', 'nanoepoch.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /architecture mismatch: prebuilds\/win32-arm64\/nanoepoch\.node/)
})

test('a glibc binary wearing a musl filename is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node'),
      join(prebuilds, 'linux-x64', 'nanoepoch.musl.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1, 'the loader would hand this binary to musl hosts, so it must never ship')
  assert.match(out, /libc mismatch: prebuilds\/linux-x64\/nanoepoch\.musl\.node is tagged musl but is linked against glibc/)
})

test('a musl binary wearing a glibc filename is refused', { skip }, () => {
  const root = makeTree((prebuilds) => {
    copyFileSync(
      join(prebuilds, 'linux-x64', 'nanoepoch.musl.node'),
      join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node')
    )
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /libc mismatch: prebuilds\/linux-x64\/nanoepoch\.glibc\.node is tagged glibc but is linked against musl/)
})

test('garbage bytes under a binary name are refused as not a binary', { skip }, () => {
  const root = makeTree((prebuilds) => {
    // Over the 4096-byte floor so this exercises the header check, not the
    // size check.
    writeFileSync(join(prebuilds, 'linux-x64', 'nanoepoch.glibc.node'), 'x'.repeat(8192))
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /not an ELF file: prebuilds\/linux-x64\/nanoepoch\.glibc\.node/)
})

test('a stray file inside prebuilds/ is reported, not crashed on', { skip }, () => {
  const root = makeTree((prebuilds) => {
    writeFileSync(join(prebuilds, '.DS_Store'), 'junk')
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /unexpected non-directory entry: prebuilds\/\.DS_Store/)
  assert.doesNotMatch(out, /ENOTDIR/, 'the guard should report the entry, not throw on it')
})

test('a missing prebuild is still refused with the exact path', { skip }, () => {
  const root = makeTree((prebuilds) => {
    rmSync(join(prebuilds, 'win32-arm64', 'nanoepoch.node'))
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /missing prebuild: prebuilds\/win32-arm64\/nanoepoch\.node/)
})

// The macOS cases use synthesised headers rather than real binaries: a Mach-O
// file only appears in a checkout built on a Mac, while the guard reads eight
// bytes that can be written by hand. The other six prebuilds are left missing
// on purpose -- those faults are reported too, and the assertions below look
// only at whether darwin was faulted.
const CPU_TYPE = { arm64: 0x0100000C, x64: 0x01000007 }
const MH_MAGIC_64 = 0xFEEDFACF
const FAT_MAGIC = 0xCAFEBABE

// 8KB clears the 4096-byte floor, so what these exercise is the header check
// and not the size check that runs before it.
function machO (cpuType, magic = MH_MAGIC_64) {
  const file = Buffer.alloc(8192)
  file.writeUInt32LE(magic, 0)
  file.writeUInt32LE(cpuType, 4)
  return file
}

function darwinTree (files) {
  const root = mkdtempSync(join(tmpdir(), 'nanoepoch-macho-'))
  fixtures.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, 'prebuilds', ...relative.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return root
}

// Only the problem lines are under test. The "found:" listing printed after
// them names every file, darwin included, whether or not anything was wrong.
function faults (out, needle) {
  return out.split('\n').filter((line) => line.startsWith('  - ') && line.includes(needle))
}

const BOTH_DARWIN = {
  'darwin-arm64/nanoepoch.node': machO(CPU_TYPE.arm64),
  'darwin-x64/nanoepoch.node': machO(CPU_TYPE.x64)
}

test('well-formed Mach-O headers draw no complaint', () => {
  const { out } = run(darwinTree(BOTH_DARWIN))
  assert.deepEqual(faults(out, 'darwin'), [], out)
})

test('an x86_64 binary hiding under the arm64 name is refused', () => {
  const root = darwinTree({ ...BOTH_DARWIN, 'darwin-arm64/nanoepoch.node': machO(CPU_TYPE.x64) })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /architecture mismatch: prebuilds\/darwin-arm64\/nanoepoch\.node is cputype 0x1000007, but darwin-arm64 requires 0x100000c/)
})

test('an arm64 binary hiding under the x64 name is refused', () => {
  const root = darwinTree({ ...BOTH_DARWIN, 'darwin-x64/nanoepoch.node': machO(CPU_TYPE.arm64) })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /architecture mismatch: prebuilds\/darwin-x64\/nanoepoch\.node is cputype 0x100000c/)
})

test('garbage bytes under a macOS binary name are refused as not Mach-O', () => {
  const root = darwinTree({ ...BOTH_DARWIN, 'darwin-x64/nanoepoch.node': 'x'.repeat(8192) })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /not a Mach-O file: prebuilds\/darwin-x64\/nanoepoch\.node/)
})

test('a universal binary is named as one rather than called corrupt', () => {
  // A stray `lipo` is the plausible mistake here, and its output IS Mach-O.
  // Reporting it as garbage would send the release engineer looking for a
  // broken compile instead of the build step that fattened the binary.
  const root = darwinTree({ ...BOTH_DARWIN, 'darwin-arm64/nanoepoch.node': machO(CPU_TYPE.arm64, FAT_MAGIC) })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /universal \(fat\) binary: prebuilds\/darwin-arm64\/nanoepoch\.node/)
})

// Resolving npm's own entry point instead of spawning `npm`: on Windows that
// name is a .cmd, which cannot be spawned without a shell, and passing an args
// array through a shell is what DEP0190 warns about.
function npmCli () {
  const candidates = []
  if (process.env.npm_execpath?.endsWith('.js')) candidates.push(process.env.npm_execpath)
  const nodeDirectory = dirname(process.execPath)
  candidates.push(join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  candidates.push(join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const cli = npmCli()

// The half of "nothing runs at install time" that no manifest check can see.
// npm compiles an installed package whose tarball root holds a binding.gyp even
// when the package declares no install script at all, so what has to be
// asserted is the file list npm actually produces -- npm decides that list, and
// "files" is only one of its inputs.
test('the tarball carries nothing npm would run at install time', {
  skip: cli ? false : 'could not locate npm-cli.js to pack with'
}, () => {
  const result = spawnSync(process.execPath, [cli, 'pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 120_000
  })
  assert.equal(result.status, 0, result.stderr)

  const files = JSON.parse(result.stdout)[0].files.map((entry) => entry.path)
  assert.ok(files.includes('index.js'), `the packed listing looks wrong: ${files.join(', ')}`)
  // Any bare *.gyp at the root, not just the literal name: npm's manifest
  // preparation globs "*.gyp" over the publish directory, so a gate that only
  // knows one filename is narrower than the rule npm applies.
  assert.deepEqual(files.filter((file) => /^[^/]+\.gyp$/.test(file)), [],
    'a *.gyp in the tarball root is an implicit `node-gyp rebuild` on every install, with no script to point at')
  assert.deepEqual(files.filter((file) => file.startsWith('scripts/')), [],
    'nothing under scripts/ is meant to reach a consumer')
  // The recipe ships one directory down, where neither of npm's two root-only
  // checks can see it. That placement is the whole reason it is shippable.
  assert.deepEqual(files.filter((file) => file.startsWith('build-recipe/')).sort(),
    ['build-recipe/README.md', 'build-recipe/binding.gyp'],
    'the build recipe must ship exactly its gyp file and its instructions')
  // `node --test` runs everything under test/, so exactly one file may ship and
  // it has to be the one written to be run on someone else's machine.
  assert.deepEqual(files.filter((file) => file.startsWith('test/')), ['test/smoke.test.mjs'],
    'only test/smoke.test.mjs may ship; node --test would execute anything else under test/')
})

test('the release gate refuses a "files" entry that would ship the whole test directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'nanoepoch-files-'))
  fixtures.push(root)
  installGate(root)
  copyFileSync(join(packageRoot, 'binding.gyp'), join(root, 'binding.gyp'))

  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  pkg.files = pkg.files.map((entry) => (entry === 'test/smoke.test.mjs' ? 'test/' : entry))
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2))

  const empty = mkdtempSync(join(tmpdir(), 'nanoepoch-empty-'))
  fixtures.push(empty)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-prebuilds.mjs'), '--root', empty], { encoding: 'utf8' })
  const out = result.stdout + result.stderr
  assert.equal(result.status, 1)
  assert.match(out, /only test\/smoke\.test\.mjs may ship/)
})

// 0.3.0 kept binding.gyp out of the tarball and still broke every install.
// npm does not publish the manifest as written: it prepares one from the
// PUBLISH DIRECTORY, which is this repository, and that preparation sets
// gypfile: true plus scripts.install = "node-gyp rebuild" whenever a
// binding.gyp is present and no install script is declared. The tarball then
// has no binding.gyp for node-gyp to find, so the install dies at
// "gyp: binding.gyp not found". Only "gypfile": false turns that off.
//
// The tarball assertion above cannot see this -- the injected script never
// reaches the tarball, only the registry -- so the manifest gets its own test.
// BUILD-INFO.json is what ties the bytes on disk to the jobs that built them,
// and it is checked whenever it is present -- so these cases only need a tree
// that HAS one. The two synthesised Mach-O files above are enough: the six
// missing binaries are reported separately, and faults() reads only the lines
// this test is about. That keeps these running on every platform on every pull
// request, unlike the real-binary cases, which skip without a release checkout.
function withBuildInfo (mutate = () => {}) {
  const root = darwinTree(BOTH_DARWIN)
  const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const binary = join(root, 'prebuilds', 'darwin-arm64', 'nanoepoch.node')
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

  const info = {
    schemaVersion: 1,
    name: 'nanoepoch',
    version: pkg.version,
    source: {
      'src/nanoepoch.c': sha256(join(packageRoot, 'src', 'nanoepoch.c')),
      'binding.gyp': sha256(join(packageRoot, 'binding.gyp'))
    },
    binaries: [{
      path: 'prebuilds/darwin-arm64/nanoepoch.node',
      sha256: sha256(binary),
      size: statSync(binary).size
    }]
  }
  mutate(info)
  writeFileSync(join(root, 'BUILD-INFO.json'), JSON.stringify(info, null, 2))
  return root
}

test('a binary that does not hash to its build record is refused', () => {
  // The accident no per-platform job can see: six artifact downloads are merged
  // into one tree, and a path collision keeps the right filename with the wrong
  // bytes. Every header check still passes; only the recorded hash disagrees.
  const root = withBuildInfo((info) => {
    info.binaries[0].sha256 = 'f'.repeat(64)
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /prebuilds\/darwin-arm64\/nanoepoch\.node hashes to [0-9a-f]{64} but BUILD-INFO\.json records f{64}/)
})

test('a source that is not what the binaries were built from is refused', () => {
  // build-recipe/README.md tells a consumer to rebuild from the shipped
  // src/nanoepoch.c and compare hashes. That instruction is only honest while
  // the shipped source is provably the compiled one.
  const root = withBuildInfo((info) => {
    info.source['src/nanoepoch.c'] = 'a'.repeat(64)
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /src\/nanoepoch\.c hashes to [0-9a-f]{64} but the binaries were built from a{64}/)
})

test('a build record describing a different release is refused', () => {
  const root = withBuildInfo((info) => {
    info.version = '0.0.1-stale'
  })
  const { status, out } = run(root)
  assert.equal(status, 1)
  assert.match(out, /BUILD-INFO\.json describes 0\.0\.1-stale but this is /)
})

test('a tree with no BUILD-INFO.json is not faulted for it outside a release', () => {
  // prepublishOnly and a contributor's `npm pack` both run this script with no
  // --expect-version and no build-info to merge. Failing there would make the
  // gate unusable locally, which is how gates stop being run.
  const { out } = run(darwinTree(BOTH_DARWIN))
  assert.deepEqual(faults(out, 'BUILD-INFO'), [], out)
})

// Two copies of one file is a drift hazard, and this is the only thing that
// makes shipping the second copy safe. It runs everywhere, on every platform,
// with no skip guard -- and .gitattributes normalises both to LF so the
// comparison means the same thing on a Windows checkout as on a Linux runner.
test('the shipped build recipe is byte-for-byte the gyp file that builds the addon', () => {
  const root = readFileSync(join(packageRoot, 'binding.gyp'))
  const shipped = readFileSync(join(packageRoot, 'build-recipe', 'binding.gyp'))
  assert.deepEqual(shipped, root,
    'build-recipe/binding.gyp has drifted from binding.gyp; a consumer following build-recipe/README.md ' +
    'would compile something other than what was published')
})

// index.d.ts and index.d.mts are separate files because the exports map
// resolves them separately, and they are byte-identical because CJS and ESM
// consumers are promised the same contract. Nothing but this kept them so.
test('the CommonJS and ESM type declarations do not drift apart', () => {
  const cjs = readFileSync(join(packageRoot, 'index.d.ts'), 'utf8')
  const esm = readFileSync(join(packageRoot, 'index.d.mts'), 'utf8')
  assert.equal(esm, cjs, 'index.d.mts and index.d.ts differ, so CJS and ESM consumers see different contracts')
})

test('the manifest disables npm\'s implicit gyp install while binding.gyp is in the repository', {
  skip: existsSync(join(packageRoot, 'binding.gyp')) ? false : 'no binding.gyp, so nothing can be injected'
}, () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.gypfile, false,
    'without "gypfile": false npm publishes an install script this package cannot satisfy')
})

test('the release gate refuses a manifest that forgot "gypfile": false', () => {
  const root = mkdtempSync(join(tmpdir(), 'nanoepoch-gypfile-'))
  fixtures.push(root)
  installGate(root)
  copyFileSync(join(packageRoot, 'binding.gyp'), join(root, 'binding.gyp'))

  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  delete pkg.gypfile
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2))

  // --root points at an empty tree, so the prebuild checks fail too. That is
  // fine: what is asserted is that the manifest fault is reported by name.
  const empty = mkdtempSync(join(tmpdir(), 'nanoepoch-empty-'))
  fixtures.push(empty)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-prebuilds.mjs'), '--root', empty], { encoding: 'utf8' })
  const out = result.stdout + result.stderr
  assert.equal(result.status, 1)
  assert.match(out, /package\.json must set "gypfile": false while binding\.gyp is in the repository/)
})
