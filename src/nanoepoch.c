/*
 * nanoepoch - current wall-clock time as nanoseconds since the Unix epoch.
 *
 * Every exported function performs a fresh read of the OS realtime clock.
 * There is no anchor, no cached base instant, and no elapsed-interval
 * arithmetic anywhere in this file: capturing a base time once and adding a
 * monotonic delta would silently ignore every subsequent NTP step or manual
 * clock change, which is the exact defect this package exists to avoid.
 *
 *   Linux/POSIX : clock_gettime(CLOCK_REALTIME)
 *   Windows     : GetSystemTimePreciseAsFileTime()
 *
 * The addon holds no mutable global state, so it is safe under worker_threads,
 * multiple Node instances, and Electron's multi-context model.
 */

#define NAPI_VERSION 6

#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#else
#  include <time.h>
#endif

/* 100ns ticks between 1601-01-01 and 1970-01-01 UTC (11,644,473,600 seconds).
 * Re-derived independently by the test suite from Date.UTC() arithmetic. */
#define NE_FILETIME_EPOCH_TICKS 116444736000000000ULL

/* INT64_MAX nanoseconds == 2262-04-11T23:47:16.854775807Z. */
#define NE_MAX_NS 9223372036854775807ULL

/* Number.MAX_SAFE_INTEGER microseconds == 2255-06-05T23:47:34.740991Z. */
#define NE_MAX_US 9007199254740991ULL

#define NE_NS_PER_SEC 1000000000ULL

#ifndef _WIN32
/* A 32-bit time_t wraps negative in 2038, after which every read would be
 * rejected as "before the epoch" -- a permanent outage rather than a wrong
 * value, but still worth refusing at build time. The prebuilt platforms are all
 * 64-bit; this only fires for someone building from source on a 32-bit target. */
typedef char ne_time_t_must_be_64_bit[sizeof(time_t) >= 8 ? 1 : -1];
#endif

typedef enum {
  NE_OK = 0,
  NE_BEFORE_EPOCH,  /* clock reads before 1970-01-01 */
  NE_ABOVE_NS_MAX,  /* beyond the largest instant representable as int64 ns */
  NE_ABOVE_US_MAX,  /* beyond the largest instant exact as a double of us */
  NE_CLOCK_FAILED   /* the OS clock call itself failed or returned garbage */
} ne_status;

/* Normalizes a failed Node-API call into a thrown JS exception. Node-API leaves
 * an exception pending for most failures; synthesize one when it did not. */
static void ne_throw_pending(napi_env env) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return;
  napi_throw_error(env, "ERR_NANOEPOCH_INTERNAL",
                   "nanoepoch: an internal Node-API call failed");
}

#define NE_CALL(env, call)          \
  do {                              \
    if ((call) != napi_ok) {        \
      ne_throw_pending((env));      \
      return NULL;                  \
    }                               \
  } while (0)

static void ne_throw_status(napi_env env, ne_status status) {
  switch (status) {
    case NE_BEFORE_EPOCH:
      napi_throw_range_error(
          env, "ERR_NANOEPOCH_BEFORE_EPOCH",
          "nanoepoch: the OS realtime clock reads before 1970-01-01T00:00:00Z, "
          "which cannot be expressed as a non-negative Unix timestamp");
      return;
    case NE_ABOVE_NS_MAX:
      napi_throw_range_error(
          env, "ERR_NANOEPOCH_OUT_OF_RANGE",
          "nanoepoch: the OS realtime clock is past "
          "2262-04-11T23:47:16.854775807Z, the last instant representable as a "
          "signed 64-bit nanosecond count");
      return;
    case NE_ABOVE_US_MAX:
      napi_throw_range_error(
          env, "ERR_NANOEPOCH_OUT_OF_RANGE",
          "nanoepoch: the OS realtime clock is past "
          "2255-06-05T23:47:34.740991Z, the last instant whose microsecond "
          "count is an exact JavaScript number; use now() for nanosecond "
          "BigInt values instead");
      return;
    default:
      napi_throw_error(env, "ERR_NANOEPOCH_CLOCK_FAILED",
                       "nanoepoch: the OS realtime clock could not be read");
      return;
  }
}

/*
 * Converts a Windows FILETIME tick count (100ns units since 1601-01-01) into
 * nanoseconds since the Unix epoch.
 *
 * The subtraction MUST happen before the multiplication. `ticks * 100` is
 * already ~1.34e19 today, which overflows int64 immediately and uint64 around
 * the year 2185; subtracting the epoch offset first keeps the intermediate at
 * the same magnitude as the result.
 *
 * Compiled on every platform (not just Windows) so the test suite can pin the
 * conversion with exact vectors everywhere.
 */
static ne_status ne_filetime_to_ns(uint64_t ticks, uint64_t *out) {
  uint64_t delta;

  if (ticks < NE_FILETIME_EPOCH_TICKS) return NE_BEFORE_EPOCH;
  delta = ticks - NE_FILETIME_EPOCH_TICKS;
  if (delta > NE_MAX_NS / 100ULL) return NE_ABOVE_NS_MAX;

  *out = delta * 100ULL;
  return NE_OK;
}

/* Reads the OS realtime clock. Called afresh on every single API invocation. */
static ne_status ne_read_ns(uint64_t *out) {
#ifdef _WIN32
  FILETIME ft;
  ULARGE_INTEGER ticks;

  GetSystemTimePreciseAsFileTime(&ft);

  /* FILETIME is only 4-byte aligned; casting its address to a 64-bit pointer
   * is undefined behaviour on 64-bit Windows. Assemble the halves instead. */
  ticks.LowPart = ft.dwLowDateTime;
  ticks.HighPart = ft.dwHighDateTime;

  return ne_filetime_to_ns(ticks.QuadPart, out);
#else
  struct timespec ts;

  /* clock_gettime and CLOCK_REALTIME are POSIX, not ISO C, so this file must be
   * compiled in a mode that exposes POSIX declarations -- see the -std=gnu99 in
   * binding.gyp. Under a strict -std=c99 musl hides them and this stops
   * compiling, while glibc exposes them anyway. */
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return NE_CLOCK_FAILED;
  if (ts.tv_nsec < 0 || (uint64_t)ts.tv_nsec >= NE_NS_PER_SEC) return NE_CLOCK_FAILED;
  if (ts.tv_sec < 0) return NE_BEFORE_EPOCH;
  if ((uint64_t)ts.tv_sec > (NE_MAX_NS - (uint64_t)ts.tv_nsec) / NE_NS_PER_SEC) {
    return NE_ABOVE_NS_MAX;
  }

  *out = (uint64_t)ts.tv_sec * NE_NS_PER_SEC + (uint64_t)ts.tv_nsec;
  return NE_OK;
#endif
}

static napi_value ne_now(napi_env env, napi_callback_info info) {
  uint64_t ns;
  napi_value result;
  ne_status status;

  (void)info;

  status = ne_read_ns(&ns);
  if (status != NE_OK) {
    ne_throw_status(env, status);
    return NULL;
  }

  NE_CALL(env, napi_create_bigint_uint64(env, ns, &result));
  return result;
}

static napi_value ne_now_micros(napi_env env, napi_callback_info info) {
  uint64_t ns, us;
  napi_value result;
  ne_status status;

  (void)info;

  status = ne_read_ns(&ns);
  if (status != NE_OK) {
    ne_throw_status(env, status);
    return NULL;
  }

  us = ns / 1000ULL;
  if (us > NE_MAX_US) {
    ne_throw_status(env, NE_ABOVE_US_MAX);
    return NULL;
  }

  NE_CALL(env, napi_create_double(env, (double)us, &result));
  return result;
}

/*
 * nowInto(target[, index]) - writes the current time into a caller-owned typed
 * array, so a hot loop can timestamp events without allocating a BigInt per
 * call. The data pointer is fetched on every call and never cached: the
 * underlying ArrayBuffer can be detached at any time from JS.
 */
static napi_value ne_now_into(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_typedarray_type type;
  size_t length = 0;
  void *data = NULL;
  uint32_t index = 0;
  uint64_t ns;
  ne_status status;
  char message[160];

  NE_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE",
                          "nanoepoch.nowInto(target[, index]): target is required");
    return NULL;
  }

  if (napi_get_typedarray_info(env, argv[0], &type, &length, &data, NULL, NULL) != napi_ok) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return NULL;
    napi_throw_type_error(
        env, "ERR_INVALID_ARG_TYPE",
        "nanoepoch.nowInto(target[, index]): target must be a BigInt64Array or "
        "a BigUint64Array");
    return NULL;
  }

  if (type != napi_bigint64_array && type != napi_biguint64_array) {
    napi_throw_type_error(
        env, "ERR_INVALID_ARG_TYPE",
        "nanoepoch.nowInto(target[, index]): target must be a BigInt64Array or "
        "a BigUint64Array");
    return NULL;
  }

  if (argc >= 2) {
    napi_valuetype value_type;
    NE_CALL(env, napi_typeof(env, argv[1], &value_type));
    if (value_type != napi_undefined) {
      double raw;
      if (value_type != napi_number) {
        napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE",
                              "nanoepoch.nowInto(target[, index]): index must be a number");
        return NULL;
      }
      NE_CALL(env, napi_get_value_double(env, argv[1], &raw));
      /* The upper bound is checked before the cast, not after: converting a
       * double outside uint32_t's range is undefined behaviour, so the cast
       * must not be reached for Infinity or anything past 2^32-1. The first
       * comparison also rejects NaN. */
      if (!(raw >= 0.0) || !(raw <= 4294967295.0) || raw != (double)(uint32_t)raw) {
        napi_throw_range_error(env, "ERR_OUT_OF_RANGE",
                               "nanoepoch.nowInto(target[, index]): index must be a "
                               "non-negative 32-bit integer");
        return NULL;
      }
      index = (uint32_t)raw;
    }
  }

  if ((size_t)index >= length) {
    if (length == 0) {
      /* An empty typed array and a view onto a detached ArrayBuffer both report
       * length 0 and are not distinguishable through Node-API 6, so say what is
       * known instead of guessing at a cause. The remedy is the same either
       * way: pass an array that actually has a slot to write. */
      napi_throw_range_error(
          env, "ERR_OUT_OF_RANGE",
          "nanoepoch.nowInto(target[, index]): target has no elements to write "
          "into; it is either empty or its ArrayBuffer has been detached");
      return NULL;
    }
    /* %zu, not %lu: unsigned long is 32-bit on 64-bit Windows, which would
     * truncate the reported length for a very large array. */
    snprintf(message, sizeof(message),
             "nanoepoch.nowInto(target[, index]): index %lu is out of bounds for a "
             "target of length %zu",
             (unsigned long)index, length);
    napi_throw_range_error(env, "ERR_OUT_OF_RANGE", message);
    return NULL;
  }

  if (data == NULL) {
    /* Unreachable in practice: a non-empty typed array always has backing
     * memory. Kept so a future runtime quirk cannot turn into a NULL write. */
    napi_throw_error(env, "ERR_INVALID_STATE",
                     "nanoepoch.nowInto(target[, index]): the target's memory is "
                     "not accessible");
    return NULL;
  }

  status = ne_read_ns(&ns);
  if (status != NE_OK) {
    ne_throw_status(env, status);
    return NULL;
  }

  if (type == napi_bigint64_array) {
    /* ne_read_ns guarantees ns <= INT64_MAX, so this never wraps. */
    ((int64_t *)data)[index] = (int64_t)ns;
  } else {
    ((uint64_t *)data)[index] = ns;
  }

  /* A NULL return with no pending exception is `undefined` to JavaScript.
   * Skipping napi_get_undefined keeps the allocation-free path minimal. */
  return NULL;
}

/*
 * _filetimeToNs(ticks) - unstable test hook exposing the pure conversion used
 * by the Windows read path. Not part of the public API and not declared in the
 * TypeScript definitions; it may be removed in any release.
 */
static napi_value ne_filetime_to_ns_js(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;
  napi_valuetype value_type;
  uint64_t ticks, ns;
  bool lossless = false;
  ne_status status;

  NE_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE",
                          "nanoepoch._filetimeToNs(ticks): ticks is required");
    return NULL;
  }

  NE_CALL(env, napi_typeof(env, argv[0], &value_type));
  if (value_type != napi_bigint) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE",
                          "nanoepoch._filetimeToNs(ticks): ticks must be a BigInt");
    return NULL;
  }

  NE_CALL(env, napi_get_value_bigint_uint64(env, argv[0], &ticks, &lossless));
  if (!lossless) {
    napi_throw_range_error(env, "ERR_OUT_OF_RANGE",
                           "nanoepoch._filetimeToNs(ticks): ticks must fit in an "
                           "unsigned 64-bit integer");
    return NULL;
  }

  status = ne_filetime_to_ns(ticks, &ns);
  if (status != NE_OK) {
    ne_throw_status(env, status);
    return NULL;
  }

  NE_CALL(env, napi_create_bigint_uint64(env, ns, &result));
  return result;
}

static napi_status ne_export(napi_env env, napi_value exports, const char *name,
                             napi_callback callback) {
  napi_value fn;
  napi_status status = napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &fn);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, exports, name, fn);
}

NAPI_MODULE_INIT(/* napi_env env, napi_value exports */) {
  uint64_t probe;

  /* Prove the platform clock works before handing out functions that promise
   * to read it, so an unusable clock fails at load time rather than at some
   * arbitrary later call. Range failures are deliberately not fatal here: they
   * describe the machine's current time, not a broken platform. */
  if (ne_read_ns(&probe) == NE_CLOCK_FAILED) {
    napi_throw_error(env, "ERR_NANOEPOCH_CLOCK_FAILED",
                     "nanoepoch: the OS realtime clock is unavailable on this system");
    return NULL;
  }

  NE_CALL(env, ne_export(env, exports, "now", ne_now));
  NE_CALL(env, ne_export(env, exports, "nowMicros", ne_now_micros));
  NE_CALL(env, ne_export(env, exports, "nowInto", ne_now_into));
  NE_CALL(env, ne_export(env, exports, "_filetimeToNs", ne_filetime_to_ns_js));

  return exports;
}
