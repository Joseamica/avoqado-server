/**
 * Unit tests for SimCustodyService.reassignPromoter
 *
 * Admin override: moves a PROMOTER_HELD or PROMOTER_PENDING SIM from one promotor
 * to another without requiring the owning-supervisor chain. Used for PlayTelecom
 * "reasignación directa" admin flows.
 *
 * DB-free: all Prisma calls are manually mocked inline (same pattern as
 * custody.distributionGate.test.ts). Does NOT use the global prismaMock.
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({
  notifySimCustody: jest.fn(),
}))

const ORG = 'org_1'
const PROMOTER_A = 'staff_promoterA'
const PROMOTER_B = 'staff_promoterB'
const ACTOR = { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' as const }

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item_1',
    venueId: null,
    organizationId: ORG,
    serialNumber: 'SIM-X',
    status: 'AVAILABLE',
    custodyState: 'PROMOTER_HELD',
    assignedSupervisorId: null,
    assignedSupervisorAt: null,
    assignedPromoterId: PROMOTER_A,
    assignedPromoterAt: new Date(),
    promoterAcceptedAt: new Date(),
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
 * @param item  SerializedItem returned by findOrgItem
 * @param promoterValid  Whether staffVenue.findFirst (promotor validation) should succeed
 */
function makeService(item: ReturnType<typeof makeItem> | null, promoterValid = true) {
  const tx = {
    serializedItem: { findFirst: jest.fn().mockResolvedValue(item) },
    // updateWithVersion uses tx.$queryRaw with RETURNING * → returns updated row
    $queryRaw: jest.fn().mockResolvedValue(item ? [{ ...item, custodyVersion: (item.custodyVersion ?? 0) + 1 }] : []),
    serializedItemCustodyEvent: { create: jest.fn().mockResolvedValue({ id: 'evt_1' }) },
  }
  const db = {
    staffVenue: {
      findFirst: jest.fn().mockResolvedValue(promoterValid ? { id: 'sv_1' } : null),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (txClient: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as import('@prisma/client').PrismaClient

  return { service: new SimCustodyService(db), tx, db: db as unknown as { staffVenue: { findFirst: jest.Mock }; $transaction: jest.Mock } }
}

/**
 * Extracts the column values updateWithVersion bound into its `tx.$queryRaw`
 * UPDATE call (the Nth call). The raw query interpolates the SET columns in a
 * fixed order (see custody.service.ts updateWithVersion):
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
    assignedSupervisorAt,
    assignedPromoterId,
    assignedPromoterAt,
    promoterAcceptedAt,
    promoterRejectedAt,
  }
}

describe('SimCustodyService — reassignPromoter', () => {
  describe('happy path', () => {
    it('reassigns a PROMOTER_HELD sim to a new promotor and writes audit', async () => {
      const item = makeItem({ custodyState: 'PROMOTER_HELD', assignedPromoterId: PROMOTER_A })
      const { service, tx } = makeService(item)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({
        serialNumber: 'SIM-X',
        status: 'ok',
        event: 'REASSIGNED_PROMOTER_TO_PROMOTER',
      })
      // State update must be called, keeping the custody state and stamping the
      // new holder. Because the SIM was PROMOTER_HELD, acceptance is re-stamped.
      expect(tx.$queryRaw).toHaveBeenCalled()
      const payload = updatePayload(tx)
      expect(payload.custodyState).toBe('PROMOTER_HELD') // state KEPT
      expect(payload.assignedPromoterId).toBe(PROMOTER_B) // moved to target
      expect(payload.promoterAcceptedAt).toBeInstanceOf(Date) // re-stamped (was HELD)
      // Audit event must record the promotor handoff
      expect(tx.serializedItemCustodyEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'REASSIGNED_PROMOTER_TO_PROMOTER',
            fromStaffId: PROMOTER_A,
            toStaffId: PROMOTER_B,
          }),
        }),
      )
    })

    it('also reassigns a PROMOTER_PENDING sim (state kept, acceptance NOT stamped)', async () => {
      const item = makeItem({
        custodyState: 'PROMOTER_PENDING',
        assignedPromoterId: PROMOTER_A,
        promoterAcceptedAt: null,
      })
      const { service, tx } = makeService(item)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({ status: 'ok', event: 'REASSIGNED_PROMOTER_TO_PROMOTER' })
      expect(tx.$queryRaw).toHaveBeenCalled()
      // Inspect the actual UPDATE payload: state is kept PENDING, the new holder
      // is set, and promoterAcceptedAt is NOT stamped (stays the item's null —
      // the new promotor still has to accept).
      const payload = updatePayload(tx)
      expect(payload.custodyState).toBe('PROMOTER_PENDING') // state KEPT
      expect(payload.assignedPromoterId).toBe(PROMOTER_B) // moved to target
      expect(payload.promoterAcceptedAt).toBeNull() // NOT stamped for PENDING
    })
  })

  describe('error paths', () => {
    it('errors NOT_FOUND when the serial does not resolve to an org item', async () => {
      // findOrgItem returns null for both org- and venue-scoped lookups.
      const { service, tx, db } = makeService(null)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-MISSING'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-MISSING', code: 'NOT_FOUND' })
      // Promotor validation passed (a tx was opened), but no mutation happened.
      expect(db.$transaction).toHaveBeenCalledTimes(1)
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('errors SIM_SOLD for a sold sim (status SOLD)', async () => {
      const item = makeItem({ status: 'SOLD' })
      const { service, tx } = makeService(item)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('SIM_SOLD')
      // No DB mutation should occur
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('errors SIM_SOLD when custodyState is SOLD even if status is not SOLD', async () => {
      // Covers the guard `status === 'SOLD' || custodyState === 'SOLD'`.
      const item = makeItem({ status: 'AVAILABLE', custodyState: 'SOLD' })
      const { service, tx } = makeService(item)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('SIM_SOLD')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('errors NOT_IN_PROMOTER_STATE for an ADMIN_HELD sim', async () => {
      const item = makeItem({ custodyState: 'ADMIN_HELD', assignedPromoterId: null })
      const { service, tx } = makeService(item)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('NOT_IN_PROMOTER_STATE')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('errors PROMOTER_NOT_FOUND when target is not an active org promotor', async () => {
      const item = makeItem()
      const { service, db } = makeService(item, false /* promoterValid = false */)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: 'nonexistent_staff',
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('PROMOTER_NOT_FOUND')
      // No transaction should be opened — validation fails upfront
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('errors PROMOTER_NOT_FOUND for ALL rows when target is invalid (multi-serial)', async () => {
      const item = makeItem()
      const { service, db } = makeService(item, false)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: 'nonexistent_staff',
        serialNumbers: ['SIM-X', 'SIM-Y', 'SIM-Z'],
      })

      expect(res.summary).toEqual({ total: 3, succeeded: 0, failed: 3 })
      expect(res.results.every(r => r.code === 'PROMOTER_NOT_FOUND')).toBe(true)
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('errors PROMOTER_NOT_FOUND for a promotor outside the actor org (tenant boundary)', async () => {
      // A staff who is a WAITER/CASHIER in ANOTHER org must not match: the
      // validation query is scoped by `venue.organizationId === actor.org`.
      const item = makeItem()
      const { service, db } = makeService(item, false /* findFirst returns null → not in this org */)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: 'promotor_other_org',
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('PROMOTER_NOT_FOUND')
      // Prove the validation is tenant-scoped to the actor's org.
      expect(db.staffVenue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            staffId: 'promotor_other_org',
            active: true,
            role: { in: ['WAITER', 'CASHIER'] },
            venue: { organizationId: ORG },
          }),
        }),
      )
      expect(db.$transaction).not.toHaveBeenCalled()
    })
  })

  describe('idempotency', () => {
    it('is idempotent when SIM is already assigned to the target promotor', async () => {
      // Item already held by PROMOTER_B — reassigning to PROMOTER_B is a no-op
      const item = makeItem({ custodyState: 'PROMOTER_HELD', assignedPromoterId: PROMOTER_B })
      const { service, tx } = makeService(item)

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-X'],
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-X', status: 'ok' })
      // No write operations on idempotent path
      expect(tx.$queryRaw).not.toHaveBeenCalled()
      expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
    })
  })

  describe('partial success', () => {
    it('reports a per-row VERSION_CONFLICT while other rows succeed (#1 ok, #2 conflict)', async () => {
      const item = makeItem({ custodyState: 'PROMOTER_HELD', assignedPromoterId: PROMOTER_A })
      const { service, tx } = makeService(item)

      // updateWithVersion reads tx.$queryRaw with RETURNING *: the first row
      // updates (1 row back), the second loses the optimistic-lock race (0 rows)
      // → updateWithVersion throws VERSION_CONFLICT for that row only.
      tx.$queryRaw.mockReset()
      tx.$queryRaw.mockResolvedValueOnce([{ ...item, custodyVersion: item.custodyVersion + 1 }])
      tx.$queryRaw.mockResolvedValueOnce([])

      const res = await service.reassignPromoter({
        actor: ACTOR,
        toPromoterStaffId: PROMOTER_B,
        serialNumbers: ['SIM-A', 'SIM-B'],
      })

      // BulkResult must reflect partial success.
      expect(res.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-A', status: 'ok', event: 'REASSIGNED_PROMOTER_TO_PROMOTER' })
      expect(res.results[1]).toMatchObject({ serialNumber: 'SIM-B', status: 'error', code: 'VERSION_CONFLICT' })
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    })
  })
})
