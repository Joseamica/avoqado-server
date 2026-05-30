import { Prisma, PrismaClient, SimRegistrationItemStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { isValidMxIccid, normalizeSerial } from './serializedInventory.service'

export interface CreateRequestInput {
  organizationId: string
  requestedByStaffId: string
  registeredFromVenueId?: string | null
  proposedCategoryId?: string | null
  serialNumbers: string[]
}
export interface CreateRequestResult {
  requestId: string | null
  submitted: number
  duplicates: string[]
  invalid: string[]
}

export interface ApproveInput {
  organizationId: string
  requestId: string
  reviewedByStaffId: string
  serialNumbers?: string[]
  categoryId: string
}
export interface ApproveResult {
  approved: number
  duplicates: number
  requestStatus: string
}
export interface RejectInput {
  organizationId: string
  requestId: string
  reviewedByStaffId: string
  serialNumbers?: string[]
  reason: string
}
export interface RejectResult {
  rejected: number
  requestStatus: string
}

export class SimRegistrationService {
  constructor(private db: PrismaClient = prisma) {}

  /** Approval feature + sale gate share one switch: org.simCustodyEnforcementMode === 'ENFORCE'. */
  async isApprovalModeEnabled(organizationId: string): Promise<boolean> {
    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { simCustodyEnforcementMode: true },
    })
    return org?.simCustodyEnforcementMode === 'ENFORCE'
  }

  async createRequest(input: CreateRequestInput): Promise<CreateRequestResult> {
    const normalized = input.serialNumbers.map(normalizeSerial)
    const invalid = normalized.filter(sn => !isValidMxIccid(sn))
    const wellFormed = normalized.filter(sn => isValidMxIccid(sn))

    const existing = await this.db.serializedItem.findMany({
      where: { organizationId: input.organizationId, serialNumber: { in: wellFormed } },
      select: { serialNumber: true },
    })
    // Legacy items may be stored with inconsistent case; mirrors custody.service.ts findOrgItem insensitive match.
    const existingSet = new Set(existing.map(e => e.serialNumber.toUpperCase()))

    const pendingItems = await this.db.simRegistrationRequestItem.findMany({
      where: {
        serialNumber: { in: wellFormed },
        status: 'PENDING' as SimRegistrationItemStatus,
        request: { organizationId: input.organizationId, status: 'PENDING' },
      },
      select: { serialNumber: true },
    })
    const pendingSet = new Set(pendingItems.map(p => p.serialNumber.toUpperCase()))

    const duplicates = wellFormed.filter(sn => existingSet.has(sn) || pendingSet.has(sn))
    const toSubmit = wellFormed.filter(sn => !existingSet.has(sn) && !pendingSet.has(sn))

    if (toSubmit.length === 0) {
      return { requestId: null, submitted: 0, duplicates, invalid }
    }

    const request = await this.db.simRegistrationRequest.create({
      data: {
        organizationId: input.organizationId,
        requestedByStaffId: input.requestedByStaffId,
        registeredFromVenueId: input.registeredFromVenueId ?? null,
        proposedCategoryId: input.proposedCategoryId ?? null,
        status: 'PENDING',
        items: {
          create: toSubmit.map(serialNumber => ({
            serialNumber,
            status: 'PENDING' as SimRegistrationItemStatus,
          })),
        },
      },
      select: { id: true },
    })

    return { requestId: request.id, submitted: toSubmit.length, duplicates, invalid }
  }

  async approve(input: ApproveInput): Promise<ApproveResult> {
    return this.db.$transaction(async (tx: any) => {
      const request = await tx.simRegistrationRequest.findUnique({
        where: { id: input.requestId },
        include: { items: true },
      })
      if (!request || request.organizationId !== input.organizationId) throw new Error('REQUEST_NOT_FOUND')

      const targetSet = input.serialNumbers ? new Set(input.serialNumbers.map(normalizeSerial)) : null
      const pending = request.items.filter((it: any) => it.status === 'PENDING' && (!targetSet || targetSet.has(it.serialNumber)))
      const serials = pending.map((it: any) => it.serialNumber)
      const existing = serials.length
        ? await tx.serializedItem.findMany({
            where: { organizationId: input.organizationId, serialNumber: { in: serials } },
            select: { serialNumber: true },
          })
        : []
      const existingSet = new Set(existing.map((e: any) => e.serialNumber))

      let approved = 0,
        duplicates = 0
      for (const it of pending) {
        if (existingSet.has(it.serialNumber)) {
          await tx.simRegistrationRequestItem.update({ where: { id: it.id }, data: { status: 'DUPLICATE' } })
          duplicates++
          continue
        }
        let created: { id: string }
        try {
          created = await tx.serializedItem.create({
            data: {
              organizationId: input.organizationId,
              categoryId: input.categoryId,
              serialNumber: it.serialNumber,
              createdBy: request.requestedByStaffId,
              registeredFromVenueId: request.registeredFromVenueId,
              status: 'AVAILABLE',
              custodyState: 'ADMIN_HELD',
            },
            select: { id: true },
          })
        } catch (err) {
          // P2002 = concurrent insert created this SIM between our re-dedup findMany and this create.
          // A P2002 inside a Postgres interactive transaction aborts the tx; any further write in the
          // same tx would fail. We count it as a duplicate and skip the item status update entirely —
          // the item stays PENDING and will resolve correctly on the next approve call.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            duplicates++
            continue
          }
          throw err
        }
        await tx.simRegistrationRequestItem.update({
          where: { id: it.id },
          data: { status: 'APPROVED', createdSerializedItemId: created.id },
        })
        approved++
      }
      const requestStatus = await this.recalcStatus(tx, input.requestId)
      await tx.simRegistrationRequest.update({
        where: { id: input.requestId },
        data: { status: requestStatus as any, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date() },
      })
      return { approved, duplicates, requestStatus }
    })
  }

  async reject(input: RejectInput): Promise<RejectResult> {
    return this.db.$transaction(async (tx: any) => {
      const request = await tx.simRegistrationRequest.findUnique({
        where: { id: input.requestId },
        include: { items: true },
      })
      if (!request || request.organizationId !== input.organizationId) throw new Error('REQUEST_NOT_FOUND')
      const targetSet = input.serialNumbers ? new Set(input.serialNumbers.map(normalizeSerial)) : null
      const pending = request.items.filter((it: any) => it.status === 'PENDING' && (!targetSet || targetSet.has(it.serialNumber)))
      let rejected = 0
      for (const it of pending) {
        await tx.simRegistrationRequestItem.update({
          where: { id: it.id },
          data: { status: 'REJECTED', rejectionReason: input.reason },
        })
        rejected++
      }
      const requestStatus = await this.recalcStatus(tx, input.requestId)
      await tx.simRegistrationRequest.update({
        where: { id: input.requestId },
        data: { status: requestStatus as any, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date() },
      })
      return { rejected, requestStatus }
    })
  }

  private async recalcStatus(tx: any, requestId: string): Promise<string> {
    const items = await tx.simRegistrationRequestItem.findMany({
      where: { requestId },
      select: { status: true },
    })
    const hasPending = items.some((i: any) => i.status === 'PENDING')
    if (hasPending) return 'PENDING'
    const approvedCount = items.filter((i: any) => i.status === 'APPROVED').length
    const rejectedish = items.filter((i: any) => i.status === 'REJECTED' || i.status === 'DUPLICATE').length
    if (approvedCount > 0 && rejectedish > 0) return 'PARTIAL'
    if (approvedCount > 0) return 'APPROVED'
    return 'REJECTED'
  }

  async listPending(organizationId: string) {
    return this.db.simRegistrationRequest.findMany({
      where: { organizationId, status: 'PENDING' },
      include: {
        items: true,
        requestedBy: { select: { id: true, firstName: true, lastName: true } },
        registeredFromVenue: { select: { id: true, name: true } },
        proposedCategory: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async countPending(organizationId: string): Promise<number> {
    return this.db.simRegistrationRequest.count({ where: { organizationId, status: 'PENDING' } })
  }

  // ==========================================
  // OWNER STOCK-APPROVAL QUEUE
  // ==========================================

  /** Count SIMs flagged for owner approval (the queue badge). */
  async countPendingStockApprovals(organizationId: string): Promise<number> {
    return this.db.serializedItem.count({
      where: { organizationId, requiresOwnerApproval: true, status: 'AVAILABLE' },
    })
  }

  /** Paginated list of flagged SIMs for the OWNER approval queue. */
  async listPendingStockApprovals(
    organizationId: string,
    opts: { cursor?: string; limit?: number; search?: string } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const where: any = { organizationId, requiresOwnerApproval: true, status: 'AVAILABLE' }
    if (opts.search) where.serialNumber = { contains: opts.search.trim().toUpperCase() }
    const rows = await this.db.serializedItem.findMany({
      where,
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      include: {
        category: { select: { id: true, name: true } },
        registeredFromVenue: { select: { id: true, name: true } },
      },
    })
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    return {
      items: items.map(it => ({
        id: it.id,
        serialNumber: it.serialNumber,
        custodyState: it.custodyState,
        category: it.category,
        registeredFromVenue: it.registeredFromVenue,
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    }
  }

  /**
   * OWNER approves flagged SIMs → they go to the warehouse (ADMIN_HELD), the
   * flag is cleared, and assignments are wiped (per Isaac: "al aprobar van al
   * almacén y de ahí se asignan a supervisor → promotor"). Bulk-capable.
   * Writes a custody event per item for the timeline.
   *
   * Event type: COLLECTED_FROM_SUPERVISOR — the closest existing enum value for
   * "item returned to warehouse / ADMIN_HELD state". The timeline is readable
   * by context: fromState tells the full story; actorStaffId identifies the
   * owner who approved. No new enum value is added (would require a migration).
   */
  async approveStockItems(input: {
    organizationId: string
    reviewedByStaffId: string
    serializedItemIds: string[]
  }): Promise<{ approved: number }> {
    let approved = 0
    for (const id of input.serializedItemIds) {
      await this.db.$transaction(async (tx: any) => {
        const item = await tx.serializedItem.findUnique({ where: { id } })
        if (!item || item.organizationId !== input.organizationId || !item.requiresOwnerApproval) return
        const fromState = item.custodyState
        await tx.serializedItem.update({
          where: { id },
          data: {
            requiresOwnerApproval: false,
            ownerApprovedAt: new Date(),
            ownerApprovedById: input.reviewedByStaffId,
            custodyState: 'ADMIN_HELD',
            assignedSupervisorId: null,
            assignedSupervisorAt: null,
            assignedPromoterId: null,
            assignedPromoterAt: null,
            promoterAcceptedAt: null,
            promoterRejectedAt: null,
          },
        })
        // COLLECTED_FROM_SUPERVISOR: closest existing enum value for
        // "returned to warehouse / ADMIN_HELD". fromState carries the prior
        // custody state; actorStaffId is the owner who approved.
        await tx.serializedItemCustodyEvent.create({
          data: {
            serializedItemId: item.id,
            serialNumber: item.serialNumber,
            eventType: 'COLLECTED_FROM_SUPERVISOR',
            fromState,
            toState: 'ADMIN_HELD',
            fromStaffId: item.assignedPromoterId ?? item.assignedSupervisorId ?? null,
            toStaffId: null,
            actorStaffId: input.reviewedByStaffId,
          },
        })
        approved++
      })
    }
    return { approved }
  }
}

export const simRegistrationService = new SimRegistrationService()
