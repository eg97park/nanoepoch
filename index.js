'use strict'

const fs = require('fs')
const path = require('path')

// Workaround for bundlers: a require() of a computed path is an expression
// webpack cannot follow, and it warns about it. Under webpack the real runtime
// require is reachable as __non_webpack_require__; everywhere else the ternary
// short-circuits before that identifier is ever evaluated.
const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require // eslint-disable-line

// Kept as structured entries rather than display strings so the support check
// is an exact match. Comparing prefixes would tell a linux-arm (32-bit) user
// that linux-arm64 covers them.
const PREBUILD_TARGETS = [
  { target: 'win32-x64', libc: '' },
  { target: 'win32-arm64', libc: '' },
  { target: 'linux-x64', libc: ' (glibc and musl)' },
  { target: 'linux-arm64', libc: ' (glibc and musl)' },
  { target: 'darwin-arm64', libc: '' },
  { target: 'darwin-x64', libc: '' }
]

// Which prebuilt filenames could serve this process, most likely first.
//
// This replaces node-gyp-build's tag grammar. That grammar exists to match
// binaries tagged by runtime (node/electron/node-webkit), ABI version, uv
// version and ARM version; nanoepoch publishes none of those, because a
// Node-API binary is runtime- and ABI-agnostic by construction. What is left
// is one filename per platform, plus a libc tag on Linux -- a list, not a
// parser. Dropping the grammar is what takes this package to zero runtime
// dependencies.
//
// On Linux the order is only a guess, and deliberately so: a wrong guess costs
// one failed dlopen, after which the other candidate is tried and wins.
// Detecting libc authoritatively means process.report.getReport(), measured at
// 4.6ms on Linux and 39ms on Windows -- too much to spend on every require when
// guessing wrong is already survivable. The cheap probe below therefore only
// decides which error gets reported first, never which libc is correct.
//
// That try-both behaviour also fixes a real misdetection: node-gyp-build reads
// /etc/alpine-release alone, so a glibc-linked Node running in an Alpine
// container (via gcompat) is told it is musl and handed a binary it cannot
// load, with no second attempt.
function candidateNames () {
  if (process.platform !== 'linux') return ['nanoepoch.node']

  // A forced value is an override, not a hint: it selects one candidate and
  // accepts the failure if that was the wrong call. The error message below
  // advertises it as the escape hatch for a misdetected libc, which only works
  // if it can also exclude.
  const forced = process.env.LIBC
  if (forced === 'glibc' || forced === 'musl') return ['nanoepoch.' + forced + '.node']

  let alpine = false
  try {
    alpine = fs.existsSync('/etc/alpine-release')
  } catch {
    // An unreadable /etc is not a reason to give up; fall through to the
    // glibc-first order and let the second candidate cover the other case.
  }
  return alpine
    ? ['nanoepoch.musl.node', 'nanoepoch.glibc.node']
    : ['nanoepoch.glibc.node', 'nanoepoch.musl.node']
}

function isLoadableFile (file) {
  try {
    // statSync, not lstatSync: a symlinked build output is a legitimate
    // contributor setup and should be followed, not rejected.
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    return stat !== undefined && stat.isFile()
  } catch {
    return false
  }
}

function firstBuildOutput (directory) {
  // binding.gyp declares exactly one target, so this is the file a local build
  // produces, and scripts/prebuild.mjs already refuses a build/Release holding
  // any other number of them. The scan below still covers a locally renamed
  // target, but it must not outrank the real name: resolveCandidates returns a
  // local build ALONE, so a stale or foreign .node that happens to sort earlier
  // hides every prebuild behind a dlopen error naming a file this project never
  // built.
  const exact = path.join(directory, 'nanoepoch.node')
  if (isLoadableFile(exact)) return exact

  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return null
  }
  // isFile() alone would drop a symlink, and a directory named something.node
  // would otherwise be handed to require().
  const binary = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.node'))
    .map((entry) => entry.name)
    .sort()[0]
  return binary ? path.join(directory, binary) : null
}

// Load order: local source build, then bundled prebuild. A local build wins so
// that `npm run dev:build` is what a contributor ends up testing -- which also
// means a stale build/ silently shadows the shipped binary. The README says so
// under Development, and the negative-control test in CI deletes both
// directories for exactly this reason.
function resolveCandidates () {
  for (const flavor of ['Release', 'Debug']) {
    const local = firstBuildOutput(path.join(__dirname, 'build', flavor))
    // Returned alone rather than appended: a local build that exists but fails
    // to load is a problem to report, not one to paper over with a prebuild
    // that happens to work.
    if (local) return [local]
  }

  const directory = path.join(__dirname, 'prebuilds', process.platform + '-' + process.arch)
  return candidateNames()
    .map((name) => path.join(directory, name))
    .filter((file) => fs.existsSync(file))
}

function detectLibc () {
  if (process.platform !== 'linux') return null
  // Mirror candidateNames() exactly: only the two recognised values force the
  // choice. Calling anything else "forced" would tell the reader an override
  // took effect when the resolver ignored it.
  if (process.env.LIBC === 'glibc' || process.env.LIBC === 'musl') {
    return process.env.LIBC + ' (forced by the LIBC environment variable)'
  }
  if (process.env.LIBC) return process.env.LIBC + ' (ignored: LIBC must be "glibc" or "musl")'
  // Only the diagnostic path pays for the authoritative check; see candidateNames().
  try {
    const report = process.report.getReport()
    if (report && report.header && report.header.glibcVersionRuntime) {
      return 'glibc ' + report.header.glibcVersionRuntime
    }
  } catch {
    return 'unknown'
  }
  return 'musl (no glibc runtime reported)'
}

// Lists what is actually on disk, filenames included, because the tags in those
// names (".glibc", ".musl") are what a libc mismatch turns on. Reporting only
// the directory would show "linux-x64" to someone whose real problem is that
// they have the glibc build and need the musl one.
function listBundledPrebuilds () {
  const root = path.join(__dirname, 'prebuilds')
  const found = []
  let directories
  try {
    directories = fs.readdirSync(root).sort()
  } catch {
    return found
  }
  for (const directory of directories) {
    let binaries = []
    try {
      binaries = fs.readdirSync(path.join(root, directory)).filter((f) => f.endsWith('.node')).sort()
    } catch {
      // fall through and report the directory alone
    }
    if (binaries.length === 0) found.push(directory + '/ (no .node file)')
    else for (const binary of binaries) found.push(directory + '/' + binary)
  }
  return found
}

function packageVersion () {
  try {
    return require('./package.json').version
  } catch {
    return 'unknown'
  }
}

// This message is part of the package's contract: an install that cannot read
// the OS clock must say exactly why and how to fix it, because the alternative
// this package refuses to offer -- a JavaScript fallback -- would keep working
// while silently returning timestamps that ignore every clock adjustment.
function loadErrorMessage (attempts) {
  const libc = detectLibc()
  const target = process.platform + '-' + process.arch
  const bundled = listBundledPrebuilds()
  const supported = PREBUILD_TARGETS.some((entry) => entry.target === target)

  // Nothing was even attempted means no file on disk carried a name this
  // process could use. Attempts that were made and failed are a different
  // problem -- a missing shared library, a corrupt file, a foreign
  // architecture -- with a different fix.
  let verdict
  if (attempts.length > 0) {
    // Deliberately not "so this is not a packaging problem": a binary for the
    // wrong architecture carries the right filename and would land here too.
    verdict = 'a binary was found and selected, but loading it failed -- the reason is in the attempts below, not in the list above'
  } else if (!supported) {
    verdict = 'your platform is NOT in the prebuilt matrix; it needs a source build'
  } else if (bundled.length === 0) {
    verdict = 'your platform IS in the prebuilt matrix but this install contains no binaries at all'
  } else if (bundled.some((entry) => entry.startsWith(target + '/'))) {
    verdict = 'a binary for ' + target + ' is present but none of the names above matched -- compare the libc tag with the filenames'
  } else {
    verdict = 'your platform IS in the prebuilt matrix, but no ' + target + ' binary reached this install'
  }

  const lines = [
    'nanoepoch@' + packageVersion() + ': failed to load the native addon, and there is no JavaScript fallback.',
    '',
    '  detected : ' + target + (libc ? ' (' + libc + ')' : ''),
    '             node ' + process.versions.node + ', Node-API ' + process.versions.napi,
    '  looked   : ' + candidateNames().join(', ') + ' in prebuilds/' + target + '/',
    '  prebuilt : ' + PREBUILD_TARGETS.map((entry) => entry.target + entry.libc).join(', '),
    '  bundled  : ' + (bundled.length ? bundled.join(', ') : '(none found in this install -- the package directory looks incomplete)'),
    '  verdict  : ' + verdict,
    '',
    'Why there is no fallback: every nanoepoch call must read the OS realtime clock',
    'directly. A JavaScript fallback could only anchor a start time and add elapsed',
    'intervals, which silently ignores NTP steps and manual clock changes -- exactly',
    'the failure mode this package exists to prevent. Failing loudly is the feature.',
    '',
    'How to fix it:',
    '  1. Reinstall so the bundled binaries are restored:',
    '       npm install nanoepoch --force',
    '  2. On Linux, if the libc above looks wrong, override the detection:',
    '       LIBC=glibc  (or)  LIBC=musl',
    '  3. Build it yourself (needs a C toolchain). The published tarball carries',
    '     no binding.gyp, so nothing compiles at install time and npm rebuild has',
    '     nothing to run -- build from a clone instead:',
    '       Debian/Ubuntu : apt-get install -y build-essential python3',
    '       Alpine        : apk add build-base python3',
    '       macOS         : xcode-select --install',
    '       Windows       : Visual Studio Build Tools, "Desktop development with C++"',
    '                       (Visual Studio 2026 also requires node-gyp >= 12.1)',
    '     then: git clone https://github.com/eg97park/nanoepoch',
    '           cd nanoepoch && npm install && npm run dev:build',
    '           npm install /path/to/nanoepoch   (from your own project)',
    '  4. Still stuck? Report it with the block above:',
    '       https://github.com/eg97park/nanoepoch/issues/new'
  ]

  if (attempts.length > 0) {
    lines.push('', 'Load attempts, in order:')
    for (const attempt of attempts) {
      lines.push('  ' + attempt.file, '    ' + (attempt.error && attempt.error.message ? attempt.error.message : String(attempt.error)))
    }
  }

  return lines.join('\n')
}

let binding
{
  const attempts = []
  for (const file of resolveCandidates()) {
    try {
      binding = runtimeRequire(file)
      break
    } catch (error) {
      // The addon itself throws with an ERR_NANOEPOCH_ code when it loaded fine
      // but the platform clock is unusable. Retrying the other libc build would
      // hit the same clock, and wrapping it in the "no binary for your platform"
      // story would send the reader hunting for a libc mismatch that does not
      // exist, so let it through untouched.
      if (error && typeof error.code === 'string' && error.code.startsWith('ERR_NANOEPOCH_')) {
        throw error
      }
      attempts.push({ file, error })
    }
  }

  if (binding === undefined) {
    // Building the diagnostic must never cost the diagnosis. If anything in the
    // environment probing above misbehaves, fall back to a plain message and
    // keep the original loader error attached as the cause.
    let message
    try {
      message = loadErrorMessage(attempts)
    } catch {
      message = 'nanoepoch: failed to load the native addon, and there is no JavaScript fallback. ' +
        'See https://github.com/eg97park/nanoepoch#there-is-no-javascript-fallback'
    }
    const error = new Error(message, { cause: attempts.length > 0 ? attempts[0].error : undefined })
    error.code = 'ERR_NANOEPOCH_LOAD_FAILED'
    throw error
  }
}

// The native functions are re-exported unwrapped: every one of them already
// reads the clock and validates its own arguments, so a JavaScript wrapper
// would only add a call frame.
//
// now() returns a BigInt created on the native side. The alternative -- have
// the addon write into a shared BigUint64Array and read the slot back in JS,
// the way process.hrtime.bigint() does -- measured about 1.9x SLOWER here
// (bench/compare.mjs), because that path has to locate and bounds-check a typed
// array on every call while hrtime's internal buffer needs no argument parsing
// at all. Creating the BigInt across the Node-API boundary is the cheaper half.
module.exports = {
  now: binding.now,
  nowMicros: binding.nowMicros,
  nowInto: binding.nowInto
}

// Unstable test hooks. Deliberately non-enumerable and absent from the
// TypeScript definitions: not public API, removable in any release.
//
// They stay in the published package rather than being stripped from it: the
// release workflow runs this suite against the prebuilt binaries that ship, so
// a hook that exists only in a development build would leave the shipped
// artifact untested exactly where the tests are most exact. See the longer note
// above ne_filetime_to_ns_js in src/nanoepoch.c.
Object.defineProperty(module.exports, '_filetimeToNs', {
  value: binding._filetimeToNs,
  enumerable: false,
  configurable: true
})

// Exposed so the resolver can be tested without a second process per case.
Object.defineProperty(module.exports, '_candidateNames', {
  value: candidateNames,
  enumerable: false,
  configurable: true
})
