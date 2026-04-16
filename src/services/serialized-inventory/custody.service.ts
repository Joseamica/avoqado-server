import {
  Prisma,
  PrismaClient,
  SerializedItem,
  SerializedItemCollectionReason,
  SerializedItemCustodyEventType,
  SerializedItemCustodyState,
  StaffRole,
} from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { SimCustodyError, type SimCustodyErrorCode } from '../../lib/sim-custody-error-codes'
import { notifySimCustody } from './custody.notifications'

// ==========================================
// TYPES
// ==========================================

export type CustodyActor = {
  staffId: string
  organizationId: string
  role: StaffRole
}

export interface BulkResultRow {
  serialNumber: string
  status: 'ok' | 'error'
  /** Present when status='ok'. Event type written to SerializedItemCustodyEvent. */
  event?: SerializedItemCustodyEventType
  eventId?: string
  /** Present when status='error'. Canonical code from sim-custody-error-codes. */
  code?: SimCustodyErrorCode
  message?: string
}

export interface BulkResult {
  summary: { total: number; succeeded: number; failed: number }
  results: BulkResultRow[]
}

export interface AssignToSupervisorRow {
  serialNumber: string
  /** Optional override; must match the item's current category if provided. */
  categoryId?: string | null
}

export interface AssignToSupervisorInput {
  actor: CustodyActor
  supervisorStaffId: string
  fallbackCategoryId?: string | null
  rows: AssignToSupervisorRow[]
  /** Filled by the idempotency middleware; null when not replayed. */
  idempotencyRequestId?: string | null
}

export interface AssignToPromoterInput {
  actor: CustodyActor
  promoterStaffId: string
  serialNumbers: string[]
  idempotencyRequestId?: string | null
}

export interface AcceptInput {
  actor: CustodyActor
  serialNumbers: string[]
  idempotencyRequestId?: string | null
}

export interface RejectInput {
  actor: CustodyActor
  serialNumber: string
}

export interface CollectInput {
  actor: CustodyActor
  serialNumber: string
  reason: SerializedItemCollectionReason
}

// ==========================================
// STATE MACHINE (SINGLE SOURCE OF TRUTH)
// ==========================================

type Transition =
  | { action: 'ASSIGN_TO_SUPERVISOR'; to: 'SUPERVISOR_HELD' }
  | { action: 'ASSIGN_TO_PROMOTER'; to: 'PROMOTER_PENDING' }
  | { action: 'ACCEPT'; to: 'PROMOTER_HELD' }
  | { action: 'REJECT'; to: 'PROMOTER_REJECTED' }
  | { action: 'COLLECT_FROM_PROMOTER'; to: 'SUPERVISOR_HELD' }
  | { action: 'COLLECT_FROM_SUPERVISOR'; to: 'ADMIN_HELD' }
  | { action: 'MARK_SOLD'; to: 'SOLD' }

const VALID_FROM_STATES: Record<Transition['action'], SerializedItemCustodyState[]> = {
  ASSIGN_TO_SUPERVISOR: ['ADMIN_HELD'],
  ASSIGN_TO_PROMOTER: ['SUPERVISOR_HELD'],
  ACCEPT: ['PROMOTER_PENDING'],
  REJECT: ['PROMOTER_PENDING'],
  COLLECT_FROM_PROMOTER: ['PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED'],
  COLLECT_FROM_SUPERVISOR: ['SUPERVISOR_HELD'],
  MARK_SOLD: ['PROMOTER_HELD'],
}

/**
 * Guard function: raises SimCustodyError if the transition is not valid
 * for the current state. Returns the new state otherwise.
 */
export function applyTransition(currentState: SerializedItemCustodyState, action: Transition['action']): Transition['to'] {
  const allowed = VALID_FROM_STATES[action]
  if (!allowed.includes(currentState)) {
    if (currentState === 'SOLD') throw new SimCustodyError('SIM_SOLD')
    if (action === 'COLLECT_FROM_SUPERVISOR') throw new SimCustodyError('HAS_DOWNSTREAM_CUSTODY')
    throw new SimCustodyError('INVALID_STATE')
  }
  switch (action) {
    case 'ASSIGN_TO_SUPERVISOR':
      return 'SUPERVISOR_HELD'
    case 'ASSIGN_TO_PROMOTER':
      return 'PROMOTER_PENDING'
    case 'ACCEPT':
      return 'PROMOTER_HELD'
    case 'REJECT':
      return 'PROMOTER_REJECTED'
    case 'COLLECT_FROM_PROMOTER':
      return 'SUPERVISOR_HELD'
    case 'COLLECT_FROM_SUPERVISOR':
      return 'ADMIN_HELD'
    case 'MARK_SOLD':
      return 'SOLD'
  }
}

const ACTION_TO_EVENT: Record<Transition['action'], SerializedItemCustodyEventType> = {
  ASSIGN_TO_SUPERVISOR: 'ASSIGNED_TO_SUPERVISOR',
  ASSIGN_TO_PROMOTER: 'ASSIGNED_TO_PROMOTER',
  ACCEPT: 'ACCEPTED_BY_PROMOTER',
  REJECT: 'REJECTED_BY_PROMOTER',
  COLLECT_FROM_PROMOTER: 'COLLECTED_FROM_PROMOTER',
  COLLECT_FROM_SUPERVISOR: 'COLLECTED_FROM_SUPERVISOR',
  MARK_SOLD: 'MARKED_SOLD',
}

// ==========================================
// SERVICE
// ==========================================

export class SimCustodyService {
  constructor(private db: PrismaClient = prisma) {}

  /**
   * Admin bulk-assigns SIMs to a Supervisor. Partial-success semantics: every
   * row processed in its own short transaction; failures reported per row.
   * Does NOT create items — only assigns existing (plan §1.1 policy).
   */
  async assignToSupervisor(input: AssignToSupervisorInput): Promise<BulkResult> {
    // `fallbackCategoryId` kept in the API shape for backward-compat but no
    // longer drives any validation. Pulled out intentionally so its absence
    // in future consumer payloads doesn't surface as a TS error.
    const { actor, supervisorStaffId, rows, idempotencyRequestId } = input
    await this.assertStaffBelongsToOrg(supervisorStaffId, actor.organizationId)

    const results: BulkResultRow[] = []
    for (const row of rows) {
      results.push(
        await this.processOneRow(row.serialNumber, async tx => {
          const item = await this.findOrgItem(tx, actor.organizationId, row.serialNumber)
          if (!item) throw new SimCustodyError('NOT_FOUND')

          // Plan revisión UX: la categoría del SIM no se valida al asignar
          // (se conserva la categoría original del registro). El dialog usa
          // `fallbackCategoryId` solo como filtro de búsqueda en el tab
          // "Buscar"; no bloqueamos la asignación si el cliente omite el
          // campo o envía valores heterogéneos.
          if (item.status === 'SOLD') throw new SimCustodyError('SIM_SOLD')
          if (item.custodyState === 'SUPERVISOR_HELD' && item.assignedSupervisorId === supervisorStaffId) {
            // Idempotent inside a non-replayed call: already assigned to same supervisor → noop ok.
            return { event: ACTION_TO_EVENT.ASSIGN_TO_SUPERVISOR, item }
          }
          if (item.custodyState !== 'ADMIN_HELD') throw new SimCustodyError('ALREADY_ASSIGNED')

          const newState = applyTransition(item.custodyState, 'ASSIGN_TO_SUPERVISOR')
          const updated = await this.updateWithVersion(tx, item, {
            custodyState: newState,
            assignedSupervisorId: supervisorStaffId,
            assignedSupervisorAt: new Date(),
            assignedPromoterId: null,
            assignedPromoterAt: null,
            promoterAcceptedAt: null,
            promoterRejectedAt: null,
          })
          await this.writeEvent(tx, {
            item: updated,
            eventType: ACTION_TO_EVENT.ASSIGN_TO_SUPERVISOR,
            fromState: item.custodyState,
            toState: newState,
            fromStaffId: null,
            toStaffId: supervisorStaffId,
            actorStaffId: actor.staffId,
            idempotencyRequestId,
          })
          return { event: ACTION_TO_EVENT.ASSIGN_TO_SUPERVISOR, item: updated }
        }),
      )
    }
    return buildSummary(results)
  }

  /**
   * Supervisor bulk-assigns to a Promoter. Only the owning supervisor may
   * transition items from SUPERVISOR_HELD → PROMOTER_PENDING.
   */
  async assignToPromoter(input: AssignToPromoterInput): Promise<BulkResult> {
    const { actor, promoterStaffId, serialNumbers, idempotencyRequestId } = input
    await this.assertStaffBelongsToOrg(promoterStaffId, actor.organizationId)

    const results: BulkResultRow[] = []
    for (const sn of serialNumbers) {
      results.push(
        await this.processOneRow(sn, async tx => {
          const item = await this.findOrgItem(tx, actor.organizationId, sn)
          if (!item) throw new SimCustodyError('NOT_FOUND')
          if (item.status === 'SOLD') throw new SimCustodyError('SIM_SOLD')
          if (item.assignedSupervisorId !== actor.staffId) {
            throw new SimCustodyError('NOT_IN_YOUR_CUSTODY')
          }
          const newState = applyTransition(item.custodyState, 'ASSIGN_TO_PROMOTER')
          const updated = await this.updateWithVersion(tx, item, {
            custodyState: newState,
            assignedPromoterId: promoterStaffId,
            assignedPromoterAt: new Date(),
            promoterAcceptedAt: null,
            promoterRejectedAt: null,
          })
          await this.writeEvent(tx, {
            item: updated,
            eventType: ACTION_TO_EVENT.ASSIGN_TO_PROMOTER,
            fromState: item.custodyState,
            toState: newState,
            fromStaffId: actor.staffId,
            toStaffId: promoterStaffId,
            actorStaffId: actor.staffId,
            idempotencyRequestId,
          })
          return { event: ACTION_TO_EVENT.ASSIGN_TO_PROMOTER, item: updated }
        }),
      )
    }

    // Post-commit notification (plan §1.8). Count ONLY rows whose transaction
    // committed successfully — pre-transaction increments could overcount if a
    // row passed ownership checks but failed at updateWithVersion (race) or
    // event persistence. Fire-and-forget; errors logged downstream.
    const committedCount = results.filter(r => r.status === 'ok').length
    if (committedCount > 0) {
      notifySimCustody({
        kind: 'ASSIGNED_TO_PROMOTER',
        targetStaffId: promoterStaffId,
        title: 'Mis SIMs',
        body: `Tienes ${committedCount} SIM${committedCount === 1 ? '' : 's'} pendiente${committedCount === 1 ? '' : 's'} de aceptar`,
        data: { route: 'MisSims', count: String(committedCount) },
      })
    }
    return buildSummary(results)
  }

  /** TPV bulk-accept: promoter accepts N pending SIMs. */
  async accept(input: AcceptInput): Promise<BulkResult> {
    const { actor, serialNumbers, idempotencyRequestId } = input
    const results: BulkResultRow[] = []
    for (const sn of serialNumbers) {
      results.push(
        await this.processOneRow(sn, async tx => {
          const item = await this.findOrgItem(tx, actor.organizationId, sn)
          if (!item) throw new SimCustodyError('NOT_FOUND')
          if (item.assignedPromoterId !== actor.staffId) {
            throw new SimCustodyError('NOT_IN_YOUR_CUSTODY')
          }
          if (item.custodyState === 'PROMOTER_HELD') throw new SimCustodyError('ALREADY_ACCEPTED')
          if (item.custodyState === 'PROMOTER_REJECTED') throw new SimCustodyError('ALREADY_REJECTED')
          const newState = applyTransition(item.custodyState, 'ACCEPT')
          const updated = await this.updateWithVersion(tx, item, {
            custodyState: newState,
            promoterAcceptedAt: new Date(),
          })
          await this.writeEvent(tx, {
            item: updated,
            eventType: ACTION_TO_EVENT.ACCEPT,
            fromState: item.custodyState,
            toState: newState,
            fromStaffId: actor.staffId,
            toStaffId: actor.staffId,
            actorStaffId: actor.staffId,
            idempotencyRequestId,
          })
          return { event: ACTION_TO_EVENT.ACCEPT, item: updated }
        }),
      )
    }
    return buildSummary(results)
  }

  /** TPV reject: promoter rejects ONE SIM (no bulk, no reason — plan §1.4). */
  async reject(input: RejectInput): Promise<{ custodyState: SerializedItemCustodyState }> {
    const { actor, serialNumber } = input
    const result = await this.db.$transaction(async tx => {
      const item = await this.findOrgItem(tx, actor.organizationId, serialNumber)
      if (!item) throw new SimCustodyError('NOT_FOUND')
      if (item.assignedPromoterId !== actor.staffId) {
        throw new SimCustodyError('NOT_IN_YOUR_CUSTODY')
      }
      if (item.custodyState === 'PROMOTER_REJECTED') throw new SimCustodyError('ALREADY_REJECTED')
      if (item.custodyState !== 'PROMOTER_PENDING') throw new SimCustodyError('INVALID_STATE')

      const newState = applyTransition(item.custodyState, 'REJECT')
      const updated = await this.updateWithVersion(tx, item, {
        custodyState: newState,
        promoterRejectedAt: new Date(),
      })
      await this.writeEvent(tx, {
        item: updated,
        eventType: ACTION_TO_EVENT.REJECT,
        fromState: item.custodyState,
        toState: newState,
        fromStaffId: actor.staffId,
        toStaffId: null,
        actorStaffId: actor.staffId,
      })
      return { custodyState: newState, supervisorStaffId: item.assignedSupervisorId }
    })

    // Plan §1.8 — notify the owning Supervisor so the red badge appears in
    // Dashboard immediately and they can recolectar.
    if (result.supervisorStaffId) {
      notifySimCustody({
        kind: 'REJECTED_ACKNOWLEDGED',
        targetStaffId: result.supervisorStaffId,
        title: 'SIM rechazado',
        body: 'Un Promotor rechazó un SIM. Debes recolectarlo.',
        data: { route: 'StockControl', serialNumber },
      })
    }

    return { custodyState: result.custodyState }
  }

  /**
   * Supervisor reclaims a SIM from the Promoter. Only the owning supervisor
   * may collect (plan §1.7 — visibility ≠ authority).
   */
  async collectFromPromoter(input: CollectInput): Promise<{ custodyState: SerializedItemCustodyState }> {
    const { actor, serialNumber, reason } = input
    const result = await this.db.$transaction(async tx => {
      const item = await this.findOrgItem(tx, actor.organizationId, serialNumber)
      if (!item) throw new SimCustodyError('NOT_FOUND')
      if (item.assignedSupervisorId !== actor.staffId) {
        throw new SimCustodyError('NOT_IN_YOUR_CUSTODY')
      }
      if (item.status === 'SOLD') throw new SimCustodyError('SIM_SOLD')

      const newState = applyTransition(item.custodyState, 'COLLECT_FROM_PROMOTER')
      const prevPromoter = item.assignedPromoterId
      const updated = await this.updateWithVersion(tx, item, {
        custodyState: newState,
        assignedPromoterId: null,
        assignedPromoterAt: null,
        promoterAcceptedAt: null,
        promoterRejectedAt: null,
      })
      await this.writeEvent(tx, {
        item: updated,
        eventType: ACTION_TO_EVENT.COLLECT_FROM_PROMOTER,
        fromState: item.custodyState,
        toState: newState,
        fromStaffId: prevPromoter,
        toStaffId: actor.staffId,
        actorStaffId: actor.staffId,
        reason,
      })
      return { custodyState: newState, prevPromoter }
    })

    // Post-commit notification — wake the Promoter's TPV so the SIM disappears
    // from Mis SIMs immediately (plan §1.8). Fire-and-forget.
    if (result.prevPromoter) {
      notifySimCustody({
        kind: 'RECOLLECTED_FROM_PROMOTER',
        targetStaffId: result.prevPromoter,
        title: 'Mis SIMs',
        body: 'Tu Supervisor recolectó un SIM. Revisa tu lista.',
        data: { route: 'MisSims', serialNumber },
      })
    }

    return { custodyState: result.custodyState }
  }

  /** Admin reclaims from Supervisor — rejects with HAS_DOWNSTREAM_CUSTODY if promoter still holds. */
  async collectFromSupervisor(input: CollectInput): Promise<{ custodyState: SerializedItemCustodyState }> {
    const { actor, serialNumber, reason } = input
    return this.db.$transaction(async tx => {
      const item = await this.findOrgItem(tx, actor.organizationId, serialNumber)
      if (!item) throw new SimCustodyError('NOT_FOUND')
      if (item.status === 'SOLD') throw new SimCustodyError('SIM_SOLD')

      const newState = applyTransition(item.custodyState, 'COLLECT_FROM_SUPERVISOR')
      const prevSupervisor = item.assignedSupervisorId
      const updated = await this.updateWithVersion(tx, item, {
        custodyState: newState,
        assignedSupervisorId: null,
        assignedSupervisorAt: null,
      })
      await this.writeEvent(tx, {
        item: updated,
        eventType: ACTION_TO_EVENT.COLLECT_FROM_SUPERVISOR,
        fromState: item.custodyState,
        toState: newState,
        fromStaffId: prevSupervisor,
        toStaffId: actor.staffId,
        actorStaffId: actor.staffId,
        reason,
      })
      return { custodyState: newState }
    })
  }

  /**
   * Lists SIMs visible to the current promoter on TPV.
   * Filters to (PROMOTER_PENDING | PROMOTER_HELD | SOLD).
   * Excludes PROMOTER_REJECTED (no longer belongs to the promoter).
   */
  async listMySims(actor: CustodyActor) {
    return this.db.serializedItem.findMany({
      where: {
        organizationId: actor.organizationId,
        assignedPromoterId: actor.staffId,
        custodyState: { in: ['PROMOTER_PENDING', 'PROMOTER_HELD', 'SOLD'] },
      },
      include: {
        category: { select: { id: true, name: true, suggestedPrice: true } },
      },
      orderBy: [{ promoterAcceptedAt: 'asc' }, { assignedPromoterAt: 'asc' }],
    })
  }

  // ==========================================
  // HELPERS
  // ==========================================

  /**
   * Atomic update that bumps custodyVersion. Throws VERSION_CONFLICT if the
   * row changed between read and write.
   *
   * Implementation uses a single fixed-shape `$executeRaw` call (no
   * `Prisma.join` over a dynamic array). The previous implementation built
   * a variable `SET` list with tagged-template nesting which, under bulk
   * (100+ rows per request) was triggering Postgres `stack depth limit
   * exceeded` from accumulated prepared-statement plans.
   *
   * Behavior: ALWAYS sets all 7 custody columns — caller passes null
   * explicitly when it wants to clear one. Drops dead-code COALESCE sentinel
   * paths. Also merges the post-update read by using `RETURNING *` via a
   * Prisma raw query so we save one round-trip per row.
   */
  private async updateWithVersion(
    tx: Prisma.TransactionClient,
    item: SerializedItem,
    patch: {
      custodyState: SerializedItemCustodyState
      assignedSupervisorId?: string | null
      assignedSupervisorAt?: Date | null
      assignedPromoterId?: string | null
      assignedPromoterAt?: Date | null
      promoterAcceptedAt?: Date | null
      promoterRejectedAt?: Date | null
    },
  ): Promise<SerializedItem> {
    // Normalise: when a key is missing from patch, preserve current row value.
    // When explicitly null, clear the column. When set, write the value.
    const assignedSupervisorId =
      'assignedSupervisorId' in patch ? patch.assignedSupervisorId : item.assignedSupervisorId
    const assignedSupervisorAt =
      'assignedSupervisorAt' in patch ? patch.assignedSupervisorAt : item.assignedSupervisorAt
    const assignedPromoterId = 'assignedPromoterId' in patch ? patch.assignedPromoterId : item.assignedPromoterId
    const assignedPromoterAt = 'assignedPromoterAt' in patch ? patch.assignedPromoterAt : item.assignedPromoterAt
    const promoterAcceptedAt = 'promoterAcceptedAt' in patch ? patch.promoterAcceptedAt : item.promoterAcceptedAt
    const promoterRejectedAt = 'promoterRejectedAt' in patch ? patch.promoterRejectedAt : item.promoterRejectedAt

    const rows = await tx.$queryRaw<SerializedItem[]>`
      UPDATE "SerializedItem"
         SET "custodyState"         = ${patch.custodyState}::"SerializedItemCustodyState",
             "assignedSupervisorId" = ${assignedSupervisorId},
             "assignedSupervisorAt" = ${assignedSupervisorAt},
             "assignedPromoterId"   = ${assignedPromoterId},
             "assignedPromoterAt"   = ${assignedPromoterAt},
             "promoterAcceptedAt"   = ${promoterAcceptedAt},
             "promoterRejectedAt"   = ${promoterRejectedAt},
             "custodyVersion"       = "custodyVersion" + 1
       WHERE "id" = ${item.id}
         AND "custodyVersion" = ${item.custodyVersion}
       RETURNING *
    `
    if (rows.length === 0) throw new SimCustodyError('VERSION_CONFLICT')
    return rows[0]
  }

  private async writeEvent(
    tx: Prisma.TransactionClient,
    e: {
      item: SerializedItem
      eventType: SerializedItemCustodyEventType
      fromState: SerializedItemCustodyState | null
      toState: SerializedItemCustodyState
      fromStaffId: string | null
      toStaffId: string | null
      actorStaffId: string
      reason?: SerializedItemCollectionReason
      idempotencyRequestId?: string | null
    },
  ): Promise<string> {
    const row = await tx.serializedItemCustodyEvent.create({
      data: {
        serializedItemId: e.item.id,
        serialNumber: e.item.serialNumber,
        eventType: e.eventType,
        fromState: e.fromState,
        toState: e.toState,
        fromStaffId: e.fromStaffId,
        toStaffId: e.toStaffId,
        actorStaffId: e.actorStaffId,
        reason: e.reason,
        idempotencyRequestId: e.idempotencyRequestId ?? null,
      },
      select: { id: true },
    })
    return row.id
  }

  /**
   * Looks up a serialized item at the org scope. Falls back to venue-scoped
   * lookup (legacy items pre-org-level). Enforces tenant isolation.
   */
  private async findOrgItem(
    tx: Prisma.TransactionClient | PrismaClient,
    organizationId: string,
    serialNumber: string,
  ): Promise<SerializedItem | null> {
    const orgItem = await tx.serializedItem.findUnique({
      where: { organizationId_serialNumber: { organizationId, serialNumber } },
    })
    if (orgItem) return orgItem

    // Legacy venue-scoped items: find by org via venue relation.
    const venueItem = await tx.serializedItem.findFirst({
      where: {
        serialNumber,
        venue: { organizationId },
      },
    })
    return venueItem
  }

  private async assertStaffBelongsToOrg(staffId: string, organizationId: string): Promise<void> {
    const membership = await this.db.staffOrganization.findFirst({
      where: { staffId, organizationId },
      select: { id: true },
    })
    if (!membership) throw new SimCustodyError('TENANT_MISMATCH')
  }

  /**
   * Wraps a single-row handler in a transaction + maps SimCustodyError to a BulkResultRow.
   * Other errors (Prisma validation, DB outage) bubble up — handled by controller.
   */
  private async processOneRow(
    serialNumber: string,
    handler: (tx: Prisma.TransactionClient) => Promise<{ event: SerializedItemCustodyEventType; item: SerializedItem }>,
  ): Promise<BulkResultRow> {
    try {
      const { event } = await this.db.$transaction(handler)
      return { serialNumber, status: 'ok', event }
    } catch (err) {
      if (err instanceof SimCustodyError) {
        return {
          serialNumber,
          status: 'error',
          code: err.code,
          message: err.message,
        }
      }
      throw err
    }
  }
}

function buildSummary(results: BulkResultRow[]): BulkResult {
  const succeeded = results.filter(r => r.status === 'ok').length
  return {
    summary: { total: results.length, succeeded, failed: results.length - succeeded },
    results,
  }
}

export const simCustodyService = new SimCustodyService()
