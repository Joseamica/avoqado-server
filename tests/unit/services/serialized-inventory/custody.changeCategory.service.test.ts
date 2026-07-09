/**
 * Unit tests for SimCustodyService.changeCategory
 *
 * Admin override: reclassify one or many SIMs to a different ItemCategory
 * without touching the custody chain. Partial-success semantics — each SIM
 * processed independently; failures are reported per row.
 *
 * `logAction` is globally mocked in tests/__helpers__/setup.ts to `jest.fn()`.
 *
 * DB-free: all Prisma calls are manually mocked inline (same pattern as
 * custody.reassign.service.test.ts). Does NOT use the global prismaMock.
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({
  notifySimCustody: jest.fn(),
}))

const mockedLogAction = logAction as unknown as jest.Mock

const ORG = 'org_1'
const ACTOR = { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' as const }
const CATEGORY_ID = 'cat-intercambio'
const CATEGORY_NAME = 'Intercambio'

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item_1',
    venueId: null,
    organizationId: ORG,
    serialNumber: 'SIM-X',
    status: 'AVAILABLE',
    categoryId: 'cat-original',
    custodyState: 'ADMIN_HELD',
    assignedSupervisorId: null,
    assignedSupervisorAt: null,
    assignedPromoterId: null,
    assignedPromoterAt: null,
    promoterAcceptedAt: null,
    promoterRejectedAt: null,
    custodyVersion: 1,
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
 * @param item   SerializedItem returned by findOrgItem (null → NOT_FOUND)
 * @param opts   categoryFound: whether the TARGET category is in the org's
 *               itemCategory.findMany result (default true). The SIM's original
 *               category ('cat-original') is ALWAYS present so fromCategoryName
 *               resolves for the audit log.
 */
function makeService(item: ReturnType<typeof makeItem> | null, opts: { categoryFound?: boolean } = {}) {
  const { categoryFound = true } = opts
  const categories = [{ id: 'cat-original', name: 'Original' }, ...(categoryFound ? [{ id: CATEGORY_ID, name: CATEGORY_NAME }] : [])]

  const tx = {
    serializedItem: {
      findFirst: jest.fn().mockResolvedValue(item),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }

  const db = {
    itemCategory: {
      findMany: jest.fn().mockResolvedValue(categories),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (txClient: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as import('@prisma/client').PrismaClient

  return {
    service: new SimCustodyService(db),
    tx,
    db: db as unknown as {
      itemCategory: { findMany: jest.Mock }
      $transaction: jest.Mock
    },
  }
}

describe('SimCustodyService — changeCategory', () => {
  beforeEach(() => {
    mockedLogAction.mockClear()
  })

  describe('happy path', () => {
    it('changes category of a non-sold SIM and logs ActivityLog', async () => {
      const item = makeItem({ categoryId: 'cat-original' })
      const { service, tx } = makeService(item)

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-X'],
        categoryId: CATEGORY_ID,
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-X', status: 'ok' })

      // updateMany must be called with the optimistic lock on the original categoryId
      expect(tx.serializedItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: item.id, categoryId: 'cat-original' }),
          data: { categoryId: CATEGORY_ID },
        }),
      )

      // ActivityLog must be written with the correct action and the full
      // category metadata (all four keys: from/to id + from/to name).
      expect(mockedLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SERIALIZED_ITEM_CATEGORY_CHANGED',
          entity: 'SerializedItem',
          entityId: item.id,
          data: expect.objectContaining({
            serialNumber: item.serialNumber,
            fromCategoryId: 'cat-original',
            fromCategoryName: 'Original',
            toCategoryId: CATEGORY_ID,
            toCategoryName: CATEGORY_NAME,
          }),
        }),
      )
    })
  })

  describe('error paths', () => {
    it('errors SIM_SOLD for a sold SIM', async () => {
      const item = makeItem({ status: 'SOLD' })
      const { service, tx } = makeService(item)

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-X'],
        categoryId: CATEGORY_ID,
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('SIM_SOLD')
      expect(tx.serializedItem.updateMany).not.toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
    })

    it('errors CATEGORY_NOT_FOUND for a category outside the org — all rows fail immediately', async () => {
      const item = makeItem()
      const { service, db, tx } = makeService(item, { categoryFound: false })

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-X', 'SIM-Y'],
        categoryId: 'cat-other-org',
      })

      expect(res.summary).toEqual({ total: 2, succeeded: 0, failed: 2 })
      expect(res.results.every(r => r.code === 'CATEGORY_NOT_FOUND')).toBe(true)
      // No transaction opened — category validation short-circuits the loop
      expect(db.$transaction).not.toHaveBeenCalled()
      expect(tx.serializedItem.updateMany).not.toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
    })

    it('errors NOT_FOUND when the serial does not resolve to an org item', async () => {
      const { service, tx } = makeService(null)

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-MISSING'],
        categoryId: CATEGORY_ID,
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-MISSING', code: 'NOT_FOUND' })
      expect(tx.serializedItem.updateMany).not.toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
    })

    it('errors VERSION_CONFLICT when the optimistic lock loses the race (updateMany count 0)', async () => {
      const item = makeItem({ categoryId: 'cat-original' })
      const { service, tx } = makeService(item)
      // Concurrent update changed the row's categoryId between read and write,
      // so the (id, categoryId) guard matches 0 rows → VERSION_CONFLICT.
      tx.serializedItem.updateMany.mockResolvedValue({ count: 0 })

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-X'],
        categoryId: CATEGORY_ID,
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('VERSION_CONFLICT')
      // The update was attempted, but the tx threw → rolled back. The audit must
      // NOT fire (proves logAction is outside/after the committed tx — no phantom
      // ActivityLog row for a change that never persisted).
      expect(tx.serializedItem.updateMany).toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
    })
  })

  describe('allowSold correction path', () => {
    it('reclassifies a SOLD SIM when allowSold=true — updates only categoryId, never the sale/status, and audits wasSold', async () => {
      const item = makeItem({ status: 'SOLD', categoryId: 'cat-original' })
      const { service, tx } = makeService(item)

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-X'],
        categoryId: CATEGORY_ID,
        allowSold: true,
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-X', status: 'ok' })

      // "Sin afectar la venta": the update touches ONLY categoryId. status stays
      // SOLD and no Payment/Order/SaleVerification field is written.
      expect(tx.serializedItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: item.id, categoryId: 'cat-original' }),
          data: { categoryId: CATEGORY_ID },
        }),
      )

      // Audit records that the corrected SIM was already sold at reclassification.
      expect(mockedLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SERIALIZED_ITEM_CATEGORY_CHANGED',
          data: expect.objectContaining({
            fromCategoryId: 'cat-original',
            toCategoryId: CATEGORY_ID,
            wasSold: true,
          }),
        }),
      )
    })

    it('still blocks a SOLD SIM when allowSold is omitted (default-safe)', async () => {
      const item = makeItem({ status: 'SOLD' })
      const { service, tx } = makeService(item)

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-X'],
        categoryId: CATEGORY_ID,
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('SIM_SOLD')
      expect(tx.serializedItem.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('idempotency', () => {
    it('is idempotent when SIM is already in the target category — status ok, no update', async () => {
      // Item already has the target categoryId — no-op
      const item = makeItem({ categoryId: CATEGORY_ID })
      const { service, tx } = makeService(item)

      const res = await service.changeCategory({
        actor: ACTOR,
        serialNumbers: ['SIM-X'],
        categoryId: CATEGORY_ID,
      })

      expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-X', status: 'ok' })
      // No DB mutation or audit write on idempotent path
      expect(tx.serializedItem.updateMany).not.toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
    })
  })
})
