{
  "targets": [
    {
      "target_name": "nanoepoch",
      "sources": ["src/nanoepoch.c"],
      "defines": ["NAPI_VERSION=6"],
      "conditions": [
        ["OS!='win'", {
          # gnu99, not c99: a strict -std=c99 defines __STRICT_ANSI__, and under
          # that musl's <time.h> hides clock_gettime and CLOCK_REALTIME, so the
          # source compiles on glibc and fails only once an Alpine build runs.
          #
          # gyp's make generator drops cflags_c on macOS -- it takes them from
          # xcode_settings instead -- so this is a no-op there. Harmless: the
          # Apple headers do not hide clock_gettime under __STRICT_ANSI__.
          "cflags_c": ["-std=gnu99"]
        }],

        # Hardening, conditioned on 'linux' and not on !='win', for two separate
        # reasons: gyp's mac flavour ignores cflags/ldflags entirely, and Apple's
        # linker rejects -z now and --as-needed outright. What the Alpine builds
        # already get from their toolchain defaults, these flags ask for
        # explicitly so the manylinux builds get them too -- the musl binaries
        # have had full RELRO and a stack canary all along and the glibc ones
        # have not. scripts/verify-prebuilds.mjs refuses a release where any of
        # this failed to take, which is the only way a silent linker change is
        # ever noticed.
        ["OS=='linux'", {
          "cflags_c": [
            "-fstack-protector-strong",
            # FORTIFY needs an optimisation level to do anything; node-gyp's
            # Release configuration already supplies one. The -U first is
            # because some distributions predefine it and redefining without
            # undefining is a warning.
            "-U_FORTIFY_SOURCE",
            "-D_FORTIFY_SOURCE=2"
          ],
          "ldflags": [
            "-Wl,-z,relro",
            "-Wl,-z,now",
            "-Wl,-z,noexecstack",
            # The addon is pure C and imports exactly clock_gettime and snprintf
            # from libc. libstdc++, libgcc_s and libm arrive only because gyp
            # links loadable_modules through the C++ driver, and libpthread only
            # because node's common.gypi puts -pthread in ldflags. --as-needed
            # drops all four; Alpine's toolchain defaults to it already, which is
            # why the musl builds have never carried them.
            "-Wl,--as-needed"
          ],
          "conditions": [
            ["target_arch=='x64'", {
              "cflags_c": ["-fcf-protection=full"]
            }],
            ["target_arch=='arm64'", {
              "cflags_c": ["-mbranch-protection=standard"]
            }]
          ]
        }],

        # xcode_settings, because the make generator reads OTHER_CFLAGS on this
        # platform and ignores cflags_c. No linker hardening: the flags above are
        # GNU ld spellings that ld64 does not accept, and macOS enables the
        # equivalents by default.
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_CFLAGS": ["-fstack-protector-strong"]
          }
        }],

        # Control Flow Guard. Node's own config.gypi sets control_flow_guard to
        # "false", so overriding that variable would collide with it --
        # AdditionalOptions is the supported way in. The cost here is close to
        # zero: every napi_* symbol is delay-loaded, so the addon's own code has
        # essentially no guard-instrumented indirect calls, while the link still
        # moves the delay-load import table out of writable .data and into
        # .didat. /GS is already on through common.gypi's BufferSecurityCheck.
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/guard:cf"] },
            "VCLinkerTool": { "AdditionalOptions": ["/guard:cf"] }
          }
        }]
      ]
    }
  ]
}
