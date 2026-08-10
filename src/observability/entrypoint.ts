/**
 * Turns a concrete request URL into a stable entry-point label.
 *
 * Two reasons this matters, and neither is cosmetic:
 *
 * 1. GROUPING. `/api/v1/orders/cmr123` and `/api/v1/orders/cmr456` are the same endpoint.
 *    Left raw, every order id becomes its own entry point and nothing groups — you can
 *    never ask "how often does this endpoint fail".
 * 2. PRIVACY. Query strings carry emails, RFCs and tokens. They must never reach a log
 *    field, let alone a third-party console.
 */

/** A cuid: 'c' followed by 24 base-36 chars. Prisma's `@default(cuid())` across this schema. */
const CUID = /^c[a-z0-9]{20,30}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC_ID = /^\d+$/

const looksLikeId = (segment: string): boolean => CUID.test(segment) || UUID.test(segment) || NUMERIC_ID.test(segment)

/**
 * `POST /api/v1/orders/cmr123?expand=items` becomes `POST /api/v1/orders/:id`.
 *
 * Deliberately conservative: only segments that are unmistakably identifiers are replaced.
 * A slug like `mindform-hidrogeno` stays, because a venue slug is a small, stable set and
 * seeing it in the entry point is useful, not noisy.
 */
export function normalizeEntrypoint(method: string, url: string): string {
  const path = url.split('?')[0]

  const normalized = path
    .split('/')
    .map(segment => (looksLikeId(segment) ? ':id' : segment))
    .join('/')

  return `${method.toUpperCase()} ${normalized}`
}
