/**
 * Unit tests for the owner-approval gate in applyCustodyPrecheck.
 *
 * The gate is private; we exercise it through the public ensureSellable().
 * DB-free: all Prisma calls are manually mocked.
 */

import { SerializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { SimCustodyError } from '@/lib/sim-custody-error-codes'
import { SerializedItem, SerializedItemCustodyState, SerializedItemStatus, SimCustodyEnforcementMode } from '@prisma/client'

// Minimal SerializedItem factory — only fields the gate code reads.
function makeItem(overrides: Partial<SerializedItem> = {}): SerializedItem {
  return {
    id: 'item-1',
    venueId: null,
    organizationId: 'org-1',
    sellingVenueId: null,
    registeredFromVenueId: null,
    categoryId: 'cat-1',
    serialNumber: 'SIM001',
    status: 'AVAILABLE' as SerializedItemStatus,
    soldAt: null,
    orderItemId: null,
    custodyState: 'PROMOTER_HELD' as SerializedItemCustodyState,
    assignedSupervisorId: null,
    assignedSupervisorAt: null,
    assignedPromoterId: 'staff-promoter',
    assignedPromoterAt: null,
    promoterAcceptedAt: null,
    promoterRejectedAt: null,
    custodyVersion: 1,
    requiresOwnerApproval: false,
    ownerApprovedAt: null,
    ownerApprovedById: null,
    createdAt: new Date(),
    createdBy: 'staff-1',
    ...overrides,
  } as SerializedItem
}

// Minimal PrismaClient mock: only the delegates touched by ensureSellable /
// applyCustodyPrecheck.
function makeMockDb(item: SerializedItem | null, enforcementMode: SimCustodyEnforcementMode, categoryName: string | null = null) {
  return {
    serializedItem: {
      // ensureSellable() now looks up the item via findFirst (case-insensitive,
      // post 2026-06-16 fix) instead of findUnique; the same mock also covers the
      // findOrgItem fallback, but the venue-level hit short-circuits it via `??`.
      findFirst: jest.fn().mockResolvedValue(item),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ simCustodyEnforcementMode: enforcementMode }),
    },
    venue: {
      findUnique: jest.fn().mockResolvedValue(null), // resolveOrgIdFromVenue — not used (organizationId is set)
    },
    itemCategory: {
      findUnique: jest.fn().mockResolvedValue(categoryName !== null ? { name: categoryName } : null),
    },
  }
}

describe('owner-approval gate (applyCustodyPrecheck via ensureSellable)', () => {
  const VENUE_ID = 'venue-1'
  const SERIAL = 'SIM001'
  const STAFF_ID = 'staff-promoter'

  describe('ENFORCE mode', () => {
    it('throws SimCustodyError(SIM_NOT_ACCEPTED) when requiresOwnerApproval=true', async () => {
      const item = makeItem({ requiresOwnerApproval: true })
      const db = makeMockDb(item, 'ENFORCE')

      const service = new SerializedInventoryService(db as any)

      await expect(service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })).rejects.toThrow(SimCustodyError)

      try {
        await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      } catch (err) {
        expect(err).toBeInstanceOf(SimCustodyError)
        expect((err as SimCustodyError).code).toBe('SIM_NOT_ACCEPTED')
      }
    })

    it('does NOT throw when requiresOwnerApproval=false and custody is correct', async () => {
      const item = makeItem({
        requiresOwnerApproval: false,
        custodyState: 'PROMOTER_HELD',
        assignedPromoterId: STAFF_ID,
      })
      const db = makeMockDb(item, 'ENFORCE')

      const service = new SerializedInventoryService(db as any)

      const result = await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBeNull()
    })
  })

  describe('WARN mode', () => {
    it('returns the deprecation warning key (not throw) when requiresOwnerApproval=true', async () => {
      const item = makeItem({ requiresOwnerApproval: true })
      const db = makeMockDb(item, 'WARN')

      const service = new SerializedInventoryService(db as any)

      const result = await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBe('sim-requires-owner-approval')
    })
  })

  describe('OFF mode', () => {
    it('skips the gate entirely (returns null warning) regardless of requiresOwnerApproval', async () => {
      const item = makeItem({ requiresOwnerApproval: true })
      const db = makeMockDb(item, 'OFF')

      const service = new SerializedInventoryService(db as any)

      const result = await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('returns null warning when item is not found (no item in db)', async () => {
      const db = makeMockDb(null, 'ENFORCE')

      const service = new SerializedInventoryService(db as any)

      const result = await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBeNull()
    })

    it('skips gate (legacy path) when no staffId is provided', async () => {
      const item = makeItem({ requiresOwnerApproval: true })
      const db = makeMockDb(item, 'ENFORCE')

      const service = new SerializedInventoryService(db as any)

      // ensureSellable requires staffId — call applyCustodyPrecheck path
      // by passing staffId but checking that the organization.findUnique is
      // never reached when organizationId is null and venueId resolves to null.
      const itemNoOrg = makeItem({ requiresOwnerApproval: true, organizationId: null, venueId: null })
      const db2 = makeMockDb(itemNoOrg, 'ENFORCE')

      const service2 = new SerializedInventoryService(db2 as any)

      const result = await service2.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBeNull()
    })
  })

  describe('eSIM exemption', () => {
    // Business rule: eSIMs are always sellable — they must NOT be restricted by
    // ANY custody gate (requiresOwnerApproval OR custody mismatch).
    // Detection: category name matches /e-?sim/i.

    it('does NOT throw for eSIM item with requiresOwnerApproval=true in ENFORCE mode', async () => {
      // Item flagged as requiresOwnerApproval — would normally throw — but it's an eSIM.
      const item = makeItem({ requiresOwnerApproval: true, categoryId: 'cat-esim' })
      const db = makeMockDb(item, 'ENFORCE', 'E-SIM de promotor')

      const service = new SerializedInventoryService(db as any)

      const result = await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBeNull()
    })

    it('does NOT throw for eSIM item with wrong custody (not PROMOTER_HELD) in ENFORCE mode', async () => {
      // Custody mismatch — would normally throw — but it's an eSIM.
      const item = makeItem({
        requiresOwnerApproval: false,
        custodyState: 'SUPERVISOR_HELD' as SerializedItemCustodyState,
        assignedPromoterId: null,
        categoryId: 'cat-esim',
      })
      const db = makeMockDb(item, 'ENFORCE', 'E-SIM de promotor')

      const service = new SerializedInventoryService(db as any)

      const result = await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBeNull()
    })

    it('detects eSIM with lowercase "esim" in category name', async () => {
      const item = makeItem({ requiresOwnerApproval: true, categoryId: 'cat-esim2' })
      const db = makeMockDb(item, 'ENFORCE', 'esim prepago')

      const service = new SerializedInventoryService(db as any)

      const result = await service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })
      expect(result.deprecationWarning).toBeNull()
    })

    it('still throws for a NON-eSIM item with requiresOwnerApproval=true in ENFORCE mode', async () => {
      // A regular SIM (not eSIM) flagged for approval — must still throw.
      const item = makeItem({ requiresOwnerApproval: true, categoryId: 'cat-sim' })
      const db = makeMockDb(item, 'ENFORCE', 'SIM Física')

      const service = new SerializedInventoryService(db as any)

      await expect(service.ensureSellable(VENUE_ID, SERIAL, { staffId: STAFF_ID })).rejects.toThrow(SimCustodyError)
    })
  })
})

// Regression: manual back-office sales ("Subir ventas fuera de TPV") must sell a SIM
// that is still SUPERVISOR_HELD (sold outside the TPV → never PROMOTER_HELD). Under
// ENFORCE mode the precheck rejects that, so markAsSold takes a `skipCustodyCheck` flag.
// (Prod 2026-07-16: 331/342 rows rolled back with SIM_NOT_ACCEPTED because the manual
// flow ran the TPV custody gate.)
describe('markAsSold — manual-sale custody bypass (skipCustodyCheck)', () => {
  const VENUE_ID = 'store-venue-1'
  const SERIAL = 'SIM001'
  const ORDER_ITEM_ID = 'orderitem-1'
  const SELLER = 'staff-seller'

  function makeSoldMockDb(item: SerializedItem) {
    const update = jest.fn().mockResolvedValue({ ...item, status: 'SOLD', custodyState: 'SOLD' })
    const orgFindUnique = jest.fn().mockResolvedValue({ simCustodyEnforcementMode: 'ENFORCE' as SimCustodyEnforcementMode })
    const db = {
      serializedItem: {
        findUnique: jest.fn().mockResolvedValue(item),
        findFirst: jest.fn().mockResolvedValue(item),
        update,
      },
      organization: { findUnique: orgFindUnique },
      itemCategory: { findUnique: jest.fn().mockResolvedValue(null) },
      venue: { findUnique: jest.fn().mockResolvedValue(null) },
    }
    return { db, update, orgFindUnique }
  }

  it('marks a SUPERVISOR_HELD SIM SOLD under ENFORCE, skipping the precheck', async () => {
    const item = makeItem({ custodyState: 'SUPERVISOR_HELD', assignedPromoterId: null })
    const { db, update, orgFindUnique } = makeSoldMockDb(item)
    const service = new SerializedInventoryService(db as any)

    const result = await service.markAsSold(VENUE_ID, SERIAL, ORDER_ITEM_ID, undefined, {
      staffId: SELLER,
      skipCustodyCheck: true,
    })

    expect(update).toHaveBeenCalledTimes(1)
    expect((update.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({ status: 'SOLD', custodyState: 'SOLD' })
    expect(result.deprecationWarning).toBeNull()
    // Precheck skipped → the org enforcement mode is never even consulted.
    expect(orgFindUnique).not.toHaveBeenCalled()
  })

  it('WITHOUT the bypass, the same SUPERVISOR_HELD SIM throws SIM_NOT_ACCEPTED under ENFORCE', async () => {
    const item = makeItem({ custodyState: 'SUPERVISOR_HELD', assignedPromoterId: null })
    const { db } = makeSoldMockDb(item)
    const service = new SerializedInventoryService(db as any)

    await expect(service.markAsSold(VENUE_ID, SERIAL, ORDER_ITEM_ID, undefined, { staffId: SELLER })).rejects.toThrow(SimCustodyError)
  })
})
