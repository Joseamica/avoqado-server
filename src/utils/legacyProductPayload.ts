/**
 * Defense at legacy HTTP boundaries whose unit-test mocks do not pass through
 * Prisma's global omit. H1 writers still receive and may explicitly read the
 * internal creator scalar; only the serialized top-level Product loses it.
 */
export function toLegacyProductPayload<T extends object>(product: T): Omit<T, 'createdById'> {
  const legacyPayload = { ...product } as T & { createdById?: unknown }
  delete legacyPayload.createdById
  return legacyPayload
}

/**
 * Venue's governance fence is an internal rollout input. Strip it again at
 * legacy HTTP boundaries so mocks or alternate clients cannot bypass Prisma's
 * global omission and change an established response shape.
 */
export function toLegacyVenuePayload<T extends object>(venue: T): Omit<T, 'catalogGovernanceEnforcedAt'> {
  const legacyPayload = { ...venue } as T & { catalogGovernanceEnforcedAt?: unknown }
  delete legacyPayload.catalogGovernanceEnforcedAt
  return legacyPayload
}
