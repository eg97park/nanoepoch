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
          "cflags_c": ["-std=gnu99"]
        }]
      ]
    }
  ]
}
