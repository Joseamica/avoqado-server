/**
 * The external bank provider mixes casing across endpoints — some respond with
 * `{ success, message }`, others with `{ Success, Message }` (confirmed
 * empirically against production: sign-in failures come back PascalCase).
 * Reading a field with `obj.field` directly is a silent landmine — it
 * resolves to `undefined` on the "wrong" casing instead of erroring loudly.
 * `pick()` checks both the literal key and its opposite-first-letter-case
 * variant before giving up.
 */
export function pick<T = unknown>(body: unknown, key: string): T | undefined {
  if (!body || typeof body !== 'object') return undefined
  const obj = body as Record<string, unknown>
  const lower = key.charAt(0).toLowerCase() + key.slice(1)
  const upper = key.charAt(0).toUpperCase() + key.slice(1)
  return (obj[key] ?? obj[lower] ?? obj[upper]) as T | undefined
}
