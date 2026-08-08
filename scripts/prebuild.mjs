// Produces one prebuilt binary for the platform this runs on:
//
//   node-gyp rebuild  ->  strip  ->  prebuilds/<platform>-<arch>/<name>.node
//
// This replaces prebuildify, which brought twenty-four packages to do the same
// three steps. The parts of prebuildify that justify that size -- building the
// same source against many Node and Electron ABIs, multi-arch tuples, uv and
// armv tags -- do not apply here: a Node-API addon is built once and loads on
// every runtime and ABI that supports Node-API 6.
//
// One deliberate difference from prebuildify: it passes
// --target=<newest version node-abi knows>, so the headers came from a static
// table that ages with the dependency. This builds against the headers of the
// Node that runs it, which is pinned by the build container (see
// scripts/build-prebuild.sh). NAPI_VERSION=6 in binding.gyp is what keeps the
// result ABI-portable either way.
//
// Usage: node scripts/prebuild.mjs [--libc glibc|musl]

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name, version } = require(join(packageRoot, 'package.json'))

function fail (message) {
  console.error(`prebuild: ${message}`)
  process.exit(1)
}

// shell defaults to false: passing arguments through a shell is unescaped
// concatenation, which Node deprecated in DEP0190. Only a bare "node-gyp.cmd"
// resolved from PATH needs one, and that call site asks for it explicitly.
function run (command, args, { optional = false, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell,
    windowsHide: true
  })
  if (result.error || result.status !== 0) {
    if (optional) return false
    fail(`${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ` with status ${result.status}`}`)
  }
  return true
}

// This package's own node-gyp devDependency, pinned to ^13 because 12.0.x
// cannot detect Visual Studio 2026; a bare "node-gyp" on PATH would silently
// pick up whichever version npm bundles, which differs per Node line. Looked up
// by literal path rather than require.resolve so the search cannot walk up into
// a surrounding node_modules and build with someone else's node-gyp.
function nodeGyp () {
  try {
    const local = join(packageRoot, 'node_modules', 'node-gyp', 'package.json')
    const manifest = require(local)
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['node-gyp']
    return { command: process.execPath, args: [join(dirname(local), bin), 'rebuild', '--release'], shell: false }
  } catch {
    // A .cmd needs a shell on Windows, and an args array sent through a shell
    // is what DEP0190 warns about, so the constant invocation goes in the
    // command string instead.
    if (process.platform === 'win32') return { command: 'node-gyp.cmd rebuild --release', args: [], shell: true }
    return { command: 'node-gyp', args: ['rebuild', '--release'], shell: false }
  }
}

// A present --libc always decides the answer, including when its value is
// missing or wrong. Falling back to autodetection there would answer a
// question the caller explicitly took out of our hands, and the wrong answer
// is a mislabelled binary in the release. Validated on every platform even
// though only Linux uses it: a typo should not depend on where it was typed.
function forcedLibc () {
  const flag = process.argv.indexOf('--libc')
  if (flag === -1) return undefined
  const forced = process.argv[flag + 1]
  if (forced !== 'glibc' && forced !== 'musl') {
    fail(`--libc must be glibc or musl, got ${forced === undefined ? 'nothing' : JSON.stringify(forced)}`)
  }
  return forced
}

// The libc a Linux binary was built against becomes part of its filename, and
// the loader refuses the other one. Unlike the loader, this can afford the
// authoritative check: it runs once per build, not once per require.
function libcTag (forced) {
  if (process.platform !== 'linux') return ''
  if (forced !== undefined) return `.${forced}`

  let glibc
  try {
    glibc = process.report.getReport().header.glibcVersionRuntime
  } catch (error) {
    fail(`could not determine libc (${error.message}); pass --libc glibc|musl`)
  }
  return glibc ? '.glibc' : '.musl'
}

// Resolved BEFORE the compile: a bad --libc or an undetectable libc should
// cost milliseconds, not surface after minutes of node-gyp output.
const tag = libcTag(forcedLibc())

const gyp = nodeGyp()
run(gyp.command, gyp.args, { shell: gyp.shell })

const releaseDir = join(packageRoot, 'build', 'Release')
let built
try {
  built = readdirSync(releaseDir).filter((entry) => entry.endsWith('.node')).sort()
} catch {
  fail(`node-gyp reported success but ${releaseDir} does not exist`)
}
if (built.length !== 1) {
  fail(`expected exactly one .node in build/Release, found ${built.length ? built.join(', ') : 'none'}`)
}
const source = join(releaseDir, built[0])

// Stripping is what takes the Linux binary from roughly 100KB of debug info to
// 14KB. Windows keeps its symbols in a separate .pdb that is never copied, so
// there is nothing to strip there.
//
// Not optional: an unstripped binary carries the build machine's absolute paths
// and is the difference between "the same image rebuilds to the same bytes" and
// a determinism report nobody can act on. A base image that loses binutils
// would otherwise ship one silently, and the release gate checks for leftover
// symbol and debug sections precisely because this step must not be skippable.
if (process.platform === 'linux' || process.platform === 'darwin') {
  const args = process.platform === 'darwin' ? ['-Sx', source] : ['--strip-all', source]
  run('strip', args)
}

const targetDir = join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`)
const target = join(targetDir, `${name}${tag}.node`)
mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)

console.log(`prebuild: ${target} (${statSync(target).size} bytes)`)

function sha256 (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// First line of a version banner, or null when the tool is not there. Never
// fatal: a missing compiler banner should degrade the record, not fail a build
// that has already succeeded.
function capture (command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: false })
    if (result.error || result.status !== 0) return null
    return `${result.stdout || result.stderr}`.split('\n')[0].trim() || null
  } catch {
    return null
  }
}

function compilerBanner () {
  if (process.platform === 'win32') {
    // cl.exe writes its banner only when compiling something, and node-gyp
    // invokes it through MSBuild, so there is no cheap version query here. The
    // runner image identity is what pins it instead, and BUILD-INFO records it.
    return process.env.VSCMD_VER
      ? `MSVC toolset ${process.env.VSCMD_VER}`
      : 'MSVC via node-gyp; see imageOs/imageVersion'
  }
  return capture(process.env.CC || 'cc', ['--version'])
}

function nodeGypVersion () {
  try {
    return require(join(packageRoot, 'node_modules', 'node-gyp', 'package.json')).version
  } catch {
    return null
  }
}

// One sidecar per binary rather than one file per job: the Linux jobs run this
// script twice over the same mounted workspace (glibc, then musl), and a shared
// filename would have the second pass overwrite the first.
//
// It goes in build-info/, never in prebuilds/. verify-prebuilds.mjs only
// collects *.node from the target directories and only reports stray entries at
// the TOP level, so a .json dropped into prebuilds/<target>/ would pass every
// check and then ship in a place nothing describes.
const record = {
  path: `prebuilds/${process.platform}-${process.arch}/${name}${tag}.node`,
  sha256: sha256(target),
  size: statSync(target).size,
  platform: process.platform,
  arch: process.arch,
  libc: tag ? tag.slice(1) : null,
  // What the binaries were compiled FROM. This is the link that makes the
  // shipped src/ and build-recipe/ auditable rather than decorative: the
  // release gate refuses a tarball whose source does not hash to what every
  // build job recorded.
  source: {
    'src/nanoepoch.c': sha256(join(packageRoot, 'src', 'nanoepoch.c')),
    'binding.gyp': sha256(join(packageRoot, 'binding.gyp'))
  },
  build: {
    node: process.version,
    napi: process.versions.napi,
    modules: process.versions.modules,
    nodeGyp: nodeGypVersion(),
    compiler: compilerBanner()
  },
  // Absent outside CI, which is the point: a locally produced record should not
  // look like one a workflow can be held to.
  ci: {
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    containerImage: process.env.BUILD_IMAGE_DIGEST ?? null
  },
  version
}

const infoDir = join(packageRoot, 'build-info')
mkdirSync(infoDir, { recursive: true })
const infoFile = join(infoDir, `${process.platform}-${process.arch}${tag}.json`)
writeFileSync(infoFile, `${JSON.stringify(record, null, 2)}\n`)

console.log(`prebuild: ${infoFile} (sha256 ${record.sha256})`)
