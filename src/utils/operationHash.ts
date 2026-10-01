import { createHash } from 'node:crypto'

/** JSON inputs only; object order is irrelevant, array order and exact string contents are not. */
export function operationHash(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, nested) =>
        nested && typeof nested === 'object' && !Array.isArray(nested)
          ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : nested,
      ),
    )
    .digest('hex')
}
