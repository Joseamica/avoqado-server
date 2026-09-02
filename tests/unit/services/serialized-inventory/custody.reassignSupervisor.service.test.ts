/**
 * Unit tests for SimCustodyService.reassignSupervisor
 *
 * Admin override: moves a SUPERVISOR_HELD SIM from one supervisor to another
 * WITHOUT the collect-from-supervisor → assign-to-supervisor round trip (which
 * is single-serial and pollutes the timeline with a fake collection).
 *
 * Scope decision (founder, Asana 1217743599033198): ONLY SUPERVISOR_HELD moves.
 * A SIM a promoter already carries keeps its old supervisor — collect it from the
 * promoter first. The PROMOTER_* cases below are the regression guard for that.
 *
 * DB-free: all Prisma calls are manually mocked inline (same pattern as
 * custody.reassign.service.test.ts). Does NOT use the global prismaMock.
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({
  notifySimCustody: jest.fn(),
}))

const ORG = 'org_1'
const SUPERVISOR_A = 'staff_supervisorA' // René
const SUPERVISOR_B = 'staff_supervisorB' // Juan
const PROMOTER = 'staff_promoter'
const ACTOR = { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' as const }

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item_1',
    venueId: null,
    organizationId: ORG,
    serialNumber: 'SIM-X',
    status: 'AVAILABLE',
    custodyState: 'SUPERVISOR_HELD',
    assignedSupervisorId: SUPERVISOR_A,
    assignedSupervisorAt: new Date('2026-01-01T00:00:00Z'),
    assignedPromoterId: null,
    assignedPromoterAt: null,
    promoterAcceptedAt: null,
    promoterRejectedAt: null,
    custodyVersion: 3,
    requiresOwnerApproval: false,
    ownerApprovedAt: null,
    ownerApprovedById: null,
    sellingVenueId: null,
    registeredFromVenueId: null,
    ...overrides,
  }
}

/**
 * Builds a SimCustodyService with inline db/tx mocks.
 * @param item              SerializedItem returned by findOrgItem
 * @param supervisorValid   Whether staffVenue.findFirst (supervisor validation) should succeed
 */
function makeService(item: ReturnType<typeof makeItem> | null, supervisorValid = true) {
  const tx = {
    serializedItem: { findFirst: jest.fn().mockResolvedValue(item) },
    $queryRaw: jest.fn().mockResolvedValue(item ? [{ ...item, custodyVersion: (item.custodyVersion ?? 0) + 1 }] : []),
    serializedItemCustodyEvent: { create: jest.fn().mockResolvedValue({ id: 'evt_1' }) },
  }
  const db = {
    staffVenue: {
      findFirst: jest.fn().mockResolvedValue(supervisorValid ? { id: 'sv_1' } : null),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (txClient: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as import('@prisma/client').PrismaClient

  return { service: new SimCustodyService(db), tx, db: db as unknown as { staffVenue: { findFirst: jest.Mock }; $transaction: jest.Mock } }
}

/**
 * Extracts the column values updateWithVersion bound into its `tx.$queryRaw`
 * UPDATE call. Fixed SET order (see custody.service.ts updateWithVersion):
 *   [0] = template strings, then custodyState, assignedSupervisorId,
 *   assignedSupervisorAt, assignedPromoterId, assignedPromoterAt,
 *   promoterAcceptedAt, promoterRejectedAt, id, custodyVersion.
 */
function updatePayload(tx: { $queryRaw: jest.Mock }, callIndex = 0) {
  const [
    ,
    custodyState,
    assignedSupervisorId,
    assignedSupervisorAt,
    assignedPromoterId,
    assignedPromoterAt,
    promoterAcceptedAt,
    promoterRejectedAt,
  ] = tx.$queryRaw.mock.calls[callIndex]
  return {
    custodyState,
    assignedSupervisorId,
    assignedSupervisorAt: unwrapDateBind(assignedSupervisorAt),
    assignedPromoterId,
    assignedPromoterAt: unwrapDateBind(assignedPromoterAt),
    promoterAcceptedAt: unwrapDateBind(promoterAcceptedAt),
    promoterRejectedAt: unwrapDateBind(promoterRejectedAt),
  }
}

/**
 * The date columns are bound through `utcTsOrNull` (src/utils/sqlDates.ts): a Prisma.sql
 * fragment carrying the Date, or the literal `NULL::timestamp`. Unwrap it so the assertions
 * keep reading the value the service decided to write.
 */
function unwrapDateBind(bind: unknown): unknown {
  if (bind && typeof bind === 'object' && 'strings' in bind && 'values' in bind) {
    const fragment = bind as { strings: string[]; values: unknown[] }
    return fragment.strings.join('').trim() === 'NULL::timestamp' ? null : fragment.values[0]
  }
  return bind
}

describe('SimCustodyService — reassignSupervisor', () => {
  describe('happy path', () => {
    it('moves a SUPERVISOR_HELD sim to the new supervisor, keeping the state', async () => {
      const item = makeItem()
      const { service, tx } = makeService(item)

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({
        serialNumber: 'SIM-X',
        status: 'ok',
        event: 'REASSIGNED_SUPERVISOR_TO_SUPERVISOR',
      })

      const payload = updatePayload(tx)
      expect(payload.custodyState).toBe('SUPERVISOR_HELD') // state KEPT — this is not a chain transition
      expect(payload.assignedSupervisorId).toBe(SUPERVISOR_B)
      expect(payload.assignedSupervisorAt).toBeInstanceOf(Date) // re-stamped for the new holder
    })

    it('writes an audit event naming both supervisors', async () => {
      const item = makeItem()
      const { service, tx } = makeService(item)

      await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(tx.serializedItemCustodyEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'REASSIGNED_SUPERVISOR_TO_SUPERVISOR',
            fromState: 'SUPERVISOR_HELD',
            toState: 'SUPERVISOR_HELD',
            fromStaffId: SUPERVISOR_A,
            toStaffId: SUPERVISOR_B,
            actorStaffId: ACTOR.staffId,
          }),
        }),
      )
    })

    it('never touches the promoter columns', async () => {
      // Regression guard: a bad patch here would silently strip a promoter
      // assignment. reassignSupervisor only ever writes the supervisor pair.
      const item = makeItem()
      const { service, tx } = makeService(item)

      await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      const payload = updatePayload(tx)
      expect(payload.assignedPromoterId).toBe(item.assignedPromoterId)
      expect(payload.assignedPromoterAt).toBe(item.assignedPromoterAt)
      expect(payload.promoterAcceptedAt).toBe(item.promoterAcceptedAt)
      expect(payload.promoterRejectedAt).toBe(item.promoterRejectedAt)
    })

    it('is a no-op when the sim is already on the target supervisor', async () => {
      const item = makeItem({ assignedSupervisorId: SUPERVISOR_B })
      const { service, tx } = makeService(item)

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({ status: 'ok', event: 'REASSIGNED_SUPERVISOR_TO_SUPERVISOR' })
      // Idempotent: no write, no duplicate audit row.
      expect(tx.$queryRaw).not.toHaveBeenCalled()
      expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
    })

    it('reports per-row results for a bulk call', async () => {
      const item = makeItem()
      const { service } = makeService(item)

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-A', 'SIM-B', 'SIM-C'],
      })

      expect(res.summary).toEqual({ total: 3, succeeded: 3, failed: 0 })
      expect(res.results.map(r => r.serialNumber)).toEqual(['SIM-A', 'SIM-B', 'SIM-C'])
    })
  })

  describe('error paths', () => {
    it('errors NOT_FOUND when the serial does not resolve to an org item', async () => {
      const { service, tx, db } = makeService(null)

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-MISSING'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-MISSING', code: 'NOT_FOUND' })
      expect(db.$transaction).toHaveBeenCalledTimes(1)
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('errors SIM_SOLD for a sold sim (status SOLD)', async () => {
      const { service, tx } = makeService(makeItem({ status: 'SOLD' }))

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.results[0].code).toBe('SIM_SOLD')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('errors SIM_SOLD when custodyState is SOLD even if status is not', async () => {
      const { service, tx } = makeService(makeItem({ status: 'AVAILABLE', custodyState: 'SOLD' }))

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.results[0].code).toBe('SIM_SOLD')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('errors NOT_IN_SUPERVISOR_STATE for an ADMIN_HELD sim (use assign-to-supervisor)', async () => {
      const { service, tx } = makeService(makeItem({ custodyState: 'ADMIN_HELD', assignedSupervisorId: null }))

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.results[0].code).toBe('NOT_IN_SUPERVISOR_STATE')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    // The founder's Option A, encoded: a SIM already down the chain is NOT moved.
    it.each(['PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED'] as const)(
      'errors NOT_IN_SUPERVISOR_STATE for a %s sim — the promoter keeps it and the old supervisor stays',
      async custodyState => {
        const { service, tx } = makeService(makeItem({ custodyState, assignedSupervisorId: SUPERVISOR_A, assignedPromoterId: PROMOTER }))

        const res = await service.reassignSupervisor({
          actor: ACTOR,
          toSupervisorStaffId: SUPERVISOR_B,
          serialNumbers: ['SIM-X'],
        })

        expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
        expect(res.results[0].code).toBe('NOT_IN_SUPERVISOR_STATE')
        expect(tx.$queryRaw).not.toHaveBeenCalled()
        expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
      },
    )

    it('errors SUPERVISOR_NOT_FOUND when the target is not an active MANAGER of the org', async () => {
      const { service, db } = makeService(makeItem(), false)

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: 'nonexistent_staff',
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('SUPERVISOR_NOT_FOUND')
      // Validation fails upfront — no transaction is ever opened.
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('errors SUPERVISOR_NOT_FOUND for ALL rows when the target is invalid (multi-serial)', async () => {
      const { service, db } = makeService(makeItem(), false)

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: 'nonexistent_staff',
        serialNumbers: ['SIM-X', 'SIM-Y', 'SIM-Z'],
      })

      expect(res.summary).toEqual({ total: 3, succeeded: 0, failed: 3 })
      expect(res.results.every(r => r.code === 'SUPERVISOR_NOT_FOUND')).toBe(true)
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('scopes the supervisor lookup to active MANAGERs of the actor org (tenant boundary)', async () => {
      const { service, db } = makeService(makeItem())

      await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(db.staffVenue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            staffId: SUPERVISOR_B,
            active: true,
            role: 'MANAGER',
            venue: { organizationId: ORG },
          }),
        }),
      )
    })

    it('errors VERSION_CONFLICT when another writer won the optimistic lock', async () => {
      const item = makeItem()
      const { service, tx } = makeService(item)
      tx.$queryRaw.mockResolvedValueOnce([]) // UPDATE matched 0 rows → someone else bumped custodyVersion

      const res = await service.reassignSupervisor({
        actor: ACTOR,
        toSupervisorStaffId: SUPERVISOR_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('VERSION_CONFLICT')
    })
  })

  describe('regression — reassignPromoter is unaffected', () => {
    it('still moves a PROMOTER_HELD sim between promotores without touching the supervisor', async () => {
      const item = makeItem({
        custodyState: 'PROMOTER_HELD',
        assignedSupervisorId: SUPERVISOR_A,
        assignedPromoterId: PROMOTER,
        promoterAcceptedAt: new Date('2026-01-02T00:00:00Z'),
      })
      const { service, tx } = makeService(item)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: 'staff_promoterB',
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      const payload = updatePayload(tx)
      expect(payload.assignedPromoterId).toBe('staff_promoterB')
      expect(payload.assignedSupervisorId).toBe(SUPERVISOR_A) // supervisor untouched
    })
  })
})
