/**
 * Pure presentation helpers for the audit trail — no database, no side effects.
 *
 * They live OUTSIDE `activity-log.service` on purpose. `tests/__helpers__/setup.ts` mocks
 * that whole module globally with `{ logAction: jest.fn() }`, because in most tests the
 * audit write is fire-and-forget noise. The side effect is that ANY pure function added to
 * that file becomes untestable — the import comes back `undefined` and the failure looks
 * like "is not a function", which sends you hunting in the wrong place.
 *
 * Keeping these here is also the better split on its own merits: redaction and formatting
 * are presentation concerns with no reason to sit next to a Prisma client.
 */

/**
 * Keys whose VALUE must never leave the server in an export.
 *
 * Ported from the regex the dashboard applies at render time (`VenueActivityLog.tsx`).
 * Porting it matters: the client-side guard only ran on ONE of the two audit screens — the
 * organization one prints `JSON.stringify(log.data)` raw — and a downloaded file passes
 * through neither. An export is exactly where a token or a card number walks out unnoticed.
 */
const SENSITIVE_KEY_RE =
  /pass(word)?|secret|token|api[-_]?key|authorization|auth|cvv|clabe|\bpan\b|card[-_]?number|account[-_]?number|private[-_]?key/i

/** Recursively replace sensitive values, preserving the shape so the row still reads. */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        SENSITIVE_KEY_RE.test(k) ? [k, '••• redacted'] : [k, redactSensitive(v)],
      ),
    )
  }
  return value
}

/**
 * The jsonb `data` column flattened to something a person can read in a spreadsheet cell.
 *
 * Dumping the raw JSON makes the file unreadable — and an audit trail nobody reads is not an
 * audit trail. Scalars become `key: value` pairs; nested structures collapse to a marker so
 * the reader knows there is more without drowning in it. The untouched JSON still travels in
 * its own column for whoever needs it.
 */
export function summarizeLogData(data: unknown, maxChars = 300): string {
  const safe = redactSensitive(data)
  if (safe === null || safe === undefined) return ''
  if (typeof safe !== 'object') return String(safe)
  const parts = Object.entries(safe as Record<string, unknown>).map(([k, v]) => {
    if (v === null || v === undefined) return `${k}: —`
    if (Array.isArray(v)) return `${k}: (${v.length})`
    if (typeof v === 'object') return `${k}: {…}`
    return `${k}: ${String(v)}`
  })
  const linea = parts.join(' · ')
  return linea.length > maxChars ? `${linea.slice(0, maxChars - 1)}…` : linea
}
