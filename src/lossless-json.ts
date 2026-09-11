/**
 * Utilities to ensure tool outputs strictly adhere to DeepSeek Harness's lossless JSON contract.
 *
 * DeepSeek Harness validates every tool output value using `snapshotJsonValue` from
 * `@deepseek-ai/dsh-util-values`. Any value containing `undefined` properties,
 * `-0`, non-finite numbers (`NaN`, `Infinity`), functions, or circular references
 * fails validation and throws:
 * `ToolOutputError: INVALID_TOOL_OUTPUT (value is not lossless JSON)`.
 */

/**
 * Detaches and sanitizes an arbitrary value to guarantee it conforms strictly to
 * DeepSeek Harness's lossless JSON requirement:
 * - Drops object properties whose values are `undefined` or symbols
 * - Converts `-0` to `0`
 * - Converts non-finite numbers (`NaN`, `Infinity`, `-Infinity`) to `null`
 * - Replaces `undefined` array entries with `null`
 * - Strips functions, symbols, and non-enumerable properties
 * - Preserves null, booleans, strings, finite numbers, plain arrays, and plain objects
 *
 * @param value - Candidate tool output value to sanitize
 * @returns A detached, strictly lossless JSON representation of the value
 */
export function toLosslessJson<T>(value: T): T {
  if (value === null || value === undefined) {
    return value
  }

  try {
    return JSON.parse(
      JSON.stringify(value, (_key, val) => {
        if (typeof val === 'number') {
          if (!Number.isFinite(val)) return null
          if (Object.is(val, -0)) return 0
        }
        return val
      })
    )
  } catch {
    // If stringify fails (e.g. cyclic reference), fallback to safe error object
    return {
      text: typeof value === 'object' && value && 'text' in value ? String((value as { text: unknown }).text) : String(value),
      isError: true,
    } as unknown as T
  }
}
