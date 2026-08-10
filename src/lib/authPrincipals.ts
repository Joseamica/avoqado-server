/**
 * Stable protocol identity for the shared break-glass login.
 *
 * This is deliberately not configurable: tokens, audit records, and access
 * checks must all classify the same synthetic subject.
 */
export const MASTER_ADMIN_PRINCIPAL_ID = 'MASTER_ADMIN' as const
