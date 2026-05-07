import type { StaffRole } from '@prisma/client'

export type CustodyAssignmentData =
  | {
      custodyState: 'PROMOTER_HELD'
      assignedPromoterId: string
      assignedPromoterAt: Date
      promoterAcceptedAt: Date
    }
  | {
      custodyState: 'SUPERVISOR_HELD'
      assignedSupervisorId: string
      assignedSupervisorAt: Date
    }
  | Record<string, never>

export function buildCustodyDataForScanner(role: StaffRole | undefined, staffId: string, now: Date = new Date()): CustodyAssignmentData {
  switch (role) {
    case 'WAITER':
      return {
        custodyState: 'PROMOTER_HELD',
        assignedPromoterId: staffId,
        assignedPromoterAt: now,
        promoterAcceptedAt: now,
      }
    case 'MANAGER':
      return {
        custodyState: 'SUPERVISOR_HELD',
        assignedSupervisorId: staffId,
        assignedSupervisorAt: now,
      }
    default:
      return {}
  }
}
