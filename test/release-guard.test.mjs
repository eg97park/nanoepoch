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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  assert.ok(!files.includes('binding.gyp'),
    'a shipped binding.gyp is an implicit `node-gyp rebuild` on every install, with no script to point at')
  assert.deepEqual(files.filter((file) => file.startsWith('scripts/')), [],
    'nothing under scripts/ is meant to reach a consumer')
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
  mkdirSync(join(root, 'scripts'))
  copyFileSync(script, join(root, 'scripts', 'verify-prebuilds.mjs'))
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
