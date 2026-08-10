import type { Prisma } from '@prisma/client'
import { MASTER_ADMIN_PRINCIPAL_ID } from './authPrincipals'

const ACTOR_SENTINELS = new Set(['SYSTEM', 'CUSTOMER', 'PUBLIC', 'WEBHOOK', MASTER_ADMIN_PRINCIPAL_ID])

function isInputJsonObject(data: Prisma.InputJsonValue | undefined): data is Prisma.InputJsonObject {
  return data !== null && typeof data === 'object' && !Array.isArray(data)
}

function withUnknownStaffId(data: Prisma.InputJsonValue | undefined, unknownStaffId: string): Prisma.InputJsonObject {
  const existing = isInputJsonObject(data) ? data : data === undefined ? {} : { legacyData: data }
  return { ...existing, unknownStaffId }
}

/**
 * Legacy ActivityLog writes only have a Staff FK. Synthetic principals are
 * therefore stored without that FK, while retaining the break-glass subject
 * in JSON until the classified actor migration reaches the generic writer.
 */
export function normalizeLegacyActivityActor(
  staffId: string | null | undefined,
  data: Prisma.InputJsonValue | undefined,
): { staffId: string | null; data: Prisma.InputJsonValue | undefined } {
  if (staffId === MASTER_ADMIN_PRINCIPAL_ID) {
    return { staffId: null, data: withUnknownStaffId(data, MASTER_ADMIN_PRINCIPAL_ID) }
  }
  return { staffId: staffId && !ACTOR_SENTINELS.has(staffId) ? staffId : null, data }
}

export function preserveUnknownStaffId(data: Prisma.InputJsonValue | undefined, unknownStaffId: string): Prisma.InputJsonObject {
  return withUnknownStaffId(data, unknownStaffId)
}
