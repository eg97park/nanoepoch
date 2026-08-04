/**
 * Current wall-clock time as integer nanoseconds since the Unix epoch.
 *
 * Reads the OS realtime clock on every call, so the result reflects NTP
 * corrections and manual clock changes immediately. That also means the value
 * can move backwards; use `process.hrtime.bigint()` to measure durations.
 *
 * The return type is `bigint` because current values are around 1.79e18, close
 * to 200 times `Number.MAX_SAFE_INTEGER`.
 *
 * @throws {RangeError} after 2262-04-11T23:47:16.854775807Z, the last instant
 * representable as a signed 64-bit nanosecond count.
 */
export declare function now(): bigint;

/**
 * Current wall-clock time as integer microseconds since the Unix epoch.
 *
 * Same fresh OS clock read as {@link now}, returned as a `number` for callers
 * who want ordinary arithmetic and JSON. Every microsecond value is an exact
 * double until 2255-06-05T23:47:34.740991Z.
 *
 * @throws {RangeError} after that instant; use {@link now} instead.
 */
export declare function nowMicros(): number;

/**
 * Writes the current wall-clock time, in nanoseconds since the Unix epoch, into
 * `target[index]`.
 *
 * Same fresh OS clock read as {@link now}, but it allocates nothing: a hot loop
 * can timestamp events into one preallocated array and defer creating BigInts
 * until the values are read back.
 *
 * @param target a `BigInt64Array` or `BigUint64Array` to write into.
 * @param index element index to write, defaulting to 0.
 * @throws {TypeError} if `target` is not one of the two accepted array types.
 * @throws {RangeError} if `index` is out of bounds.
 */
export declare function nowInto(
  target: BigInt64Array | BigUint64Array,
  index?: number
): void;
