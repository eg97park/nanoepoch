// What a shipped nanoepoch binary must be able to say about itself, expressed
// once so that the release gate (scripts/verify-prebuilds.mjs) and the
// per-pull-request check (scripts/check-hardening.mjs) cannot drift apart.
//
// Every property here is invisible to the test suite: no assertion about now()
// can tell whether the linker applied RELRO, and a toolchain that silently
// stops applying it produces a binary that passes every functional test. These
// are the only checks that would notice, so they run against the artifacts that
// actually ship rather than against a local build.
//
// The flags that produce them live in binding.gyp. Flags and checks have to
// move together: checks ahead of flags fail the next release, flags ahead of
// checks regress silently the first time a base image moves.

import { parseElf, parseMachO, parsePe, PE_DYNAMIC_BASE, PE_GUARD_CF, PE_HIGH_ENTROPY_VA, PE_NX_COMPAT, GUARD_CF_FUNCTION_TABLE_PRESENT, GUARD_CF_INSTRUMENTED } from './binfmt.mjs'

// Exact sets, not "does not contain". The addon imports clock_gettime and
// snprintf and nothing else, so anything beyond libc is a linker artefact --
// and an exact set is simultaneously the libc-tag check and the --as-needed
// regression check.
export const NEEDED = {
  'linux-x64-glibc': ['libc.so.6'],
  'linux-arm64-glibc': ['libc.so.6'],
  'linux-x64-musl': ['libc.musl-x86_64.so.1'],
  'linux-arm64-musl': ['libc.musl-aarch64.so.1']
}

// The floor the README advertises. Checked as an upper bound on what the binary
// requires: a toolchain bump that raised the real floor would otherwise make
// the documentation quietly wrong on the machines least able to notice.
export const GLIBC_FLOOR = [2, 28]

// Inherited from the Node headers' MACOSX_DEPLOYMENT_TARGET rather than set
// here, which is exactly why it is worth checking.
export const MACOS_FLOOR = [13, 5]

export const TARGETS = [
  'win32-x64', 'win32-arm64',
  'linux-x64-glibc', 'linux-x64-musl',
  'linux-arm64-glibc', 'linux-arm64-musl',
  'darwin-x64', 'darwin-arm64'
]

const MACHINE = {
  'win32-x64': 0x8664,
  'win32-arm64': 0xAA64,
  'linux-x64-glibc': 62,
  'linux-x64-musl': 62,
  'linux-arm64-glibc': 183,
  'linux-arm64-musl': 183,
  'darwin-x64': 0x01000007,
  'darwin-arm64': 0x0100000C
}

function compareVersion (a, b) {
  return (a[0] - b[0]) || (a[1] - b[1])
}

// Returns { problems, notes }. `problems` fail a release; `notes` are reported
// so a human can see what the binary claims without the build going red.
//
// skipMachine is for scripts/verify-prebuilds.mjs, which checks the
// architecture itself against the directory name and phrases the failure in
// terms of the merge accident it is looking for. Reporting it twice, in two
// wordings, would read as two faults.
export function inspect (buffer, target, { skipMachine = false } = {}) {
  const problems = []
  const notes = []
  const fault = (message) => problems.push(message)

  if (!TARGETS.includes(target)) {
    return { problems: [`unknown target "${target}"; expected one of ${TARGETS.join(', ')}`], notes }
  }

  if (target.startsWith('win32-')) {
    const pe = parsePe(buffer)
    if (!pe.ok) return { problems: [pe.problem], notes }

    if (!skipMachine && pe.machine !== MACHINE[target]) {
      fault(`machine is 0x${pe.machine.toString(16)} but ${target} requires 0x${MACHINE[target].toString(16)}`)
    }
    for (const [bit, name] of [
      [PE_HIGH_ENTROPY_VA, 'high-entropy ASLR'],
      [PE_DYNAMIC_BASE, 'ASLR (DYNAMIC_BASE)'],
      [PE_NX_COMPAT, 'DEP (NX_COMPAT)'],
      [PE_GUARD_CF, 'Control Flow Guard (/guard:cf)']
    ]) {
      if ((pe.dllCharacteristics & bit) === 0) {
        fault(`${name} is off (DllCharacteristics 0x${pe.dllCharacteristics.toString(16)})`)
      }
    }
    // The DllCharacteristics bit alone is not enough. A statically linked MSVC
    // CRT contributes CF_INSTRUMENTED on its own, so a build where /guard:cf
    // was declined still reports 0x100 with an empty function table -- which is
    // exactly the state every binary before 0.3.2 was in.
    if ((pe.guardFlags & GUARD_CF_INSTRUMENTED) === 0 ||
        (pe.guardFlags & GUARD_CF_FUNCTION_TABLE_PRESENT) === 0 ||
        pe.guardCfFunctionCount === 0) {
      fault(`Control Flow Guard is cosmetic: guard flags 0x${pe.guardFlags.toString(16)}, ` +
        `${pe.guardCfFunctionCount} guarded functions -- the linker did not really apply /guard:cf`)
    }
    notes.push(`DllCharacteristics 0x${pe.dllCharacteristics.toString(16)}, ` +
      `guard flags 0x${pe.guardFlags.toString(16)}, ${pe.guardCfFunctionCount} guarded functions`)
    return { problems, notes }
  }

  if (target.startsWith('darwin-')) {
    const macho = parseMachO(buffer)
    if (!macho.ok) return { problems: [macho.problem], notes }

    if (!skipMachine && macho.cpuType !== MACHINE[target]) {
      fault(`cputype is 0x${macho.cpuType.toString(16)} but ${target} requires 0x${MACHINE[target].toString(16)}`)
    }
    if (macho.minos === null) {
      notes.push('no LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX; minimum OS unknown')
    } else {
      const minos = [(macho.minos >> 16) & 0xFFFF, (macho.minos >> 8) & 0xFF]
      // Checked as a ceiling, not equality. A binary that runs on something
      // OLDER than advertised is conservative documentation; one that needs
      // something newer makes the README wrong for the readers least able to
      // find out.
      if (compareVersion(minos, MACOS_FLOOR) > 0) {
        fault(`requires macOS ${macho.minosText}, above the ${MACOS_FLOOR.join('.')} floor the README advertises`)
      }
      notes.push(`minimum macOS ${macho.minosText}`)
    }
    // Reported, not gated -- the one hardening property in this file that has
    // never been checked against a real artifact, because producing a Mach-O
    // binary needs a Mac and neither Docker nor a Linux cross-toolchain will
    // stand in for one. The flag itself is verified: gyp's make generator
    // discards `cflags_c` on this platform and reads OTHER_CFLAGS instead
    // (xcode_emulation.py, GetCflagsC), which is how binding.gyp spells it.
    // Promote this to a fault once a release has shown it true on both darwin
    // targets.
    notes.push(macho.hasStackChk
      ? 'references ___stack_chk_fail (stack protector present)'
      : 'no ___stack_chk_fail reference (-fstack-protector-strong may not have taken)')
    return { problems, notes }
  }

  const elf = parseElf(buffer)
  if (!elf.ok) return { problems: [elf.problem], notes }

  if (!skipMachine && elf.machine !== MACHINE[target]) {
    fault(`e_machine is ${elf.machine} but ${target} requires ${MACHINE[target]}`)
  }
  if (!elf.hasRelro) fault('no PT_GNU_RELRO segment (-Wl,-z,relro did not take)')
  if (!elf.bindNow) {
    fault('no BIND_NOW (-Wl,-z,now did not take): the relocations RELRO protects are still resolved lazily')
  }
  if (!elf.hasGnuStack) fault('no PT_GNU_STACK segment, so the stack is executable by default')
  else if (elf.gnuStackExecutable) fault('the stack is marked executable')
  if (!elf.hasStackChk) {
    fault('no __stack_chk_fail in the dynamic symbols (-fstack-protector-strong did not take)')
  }
  if (elf.hasSymtab || elf.hasDebugSections) {
    fault('symbol or debug sections survived, so this binary was shipped unstripped')
  }

  const expected = NEEDED[target]
  const actual = [...elf.needed].sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fault(`links against ${actual.join(', ') || '(nothing)'} but ${target} must link exactly ${expected.join(', ')}`)
  }

  if (target.endsWith('-glibc')) {
    if (elf.maxGlibc === null) {
      fault('no versioned glibc symbols at all, which a glibc build should have')
    } else {
      const required = elf.maxGlibc.split('.').map(Number)
      if (compareVersion(required, GLIBC_FLOOR) > 0) {
        fault(`requires GLIBC_${elf.maxGlibc}, above the ${GLIBC_FLOOR.join('.')} floor the README advertises`)
      }
      notes.push(`highest glibc symbol version GLIBC_${elf.maxGlibc}`)
    }
  }

  // Reported rather than gated. The x64 builds get it from -fcf-protection and
  // the arm64 ones from -mbranch-protection, but whether a given toolchain
  // emits the note is its own decision, and a missing note is not by itself a
  // weaker binary. Promote this to a fault once it has been seen on all four
  // Linux targets.
  notes.push(elf.hasGnuProperty ? 'carries a GNU property note' : 'no GNU property note')

  return { problems, notes }
}
