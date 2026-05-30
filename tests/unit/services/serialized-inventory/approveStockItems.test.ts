/**
 * Unit tests for SimRegistrationService.approveStockItems.
 * Covers: happy path (flagged item → ADMIN_HELD + event), org mismatch skip,
 * and not-flagged item skip.
 */
import { SimRegistrationService } from '@/services/serialized-inventory/simRegistration.service'

function makeItem(overrides: any = {}) {
  return {
    id: 'item_1',
    organizationId: 'org_1',
    serialNumber: '8952140000001234567',
    custodyState: 'AVAILABLE',
    requiresOwnerApproval: true,
    assignedSupervisorId: null,
    assignedPromoterId: null,
    ...overrides,
  }
}

function makeTx(item: any) {
  return {
    serializedItem: {
      findUnique: jest.fn().mockResolvedValue(item),
      update: jest.fn().mockResolvedValue({ ...item }),
    },
    serializedItemCustodyEvent: {
      create: jest.fn().mockResolvedValue({ id: 'evt_1' }),
    },
  }
}

function makeDb(tx: any) {
  return {
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
  } as any
}

describe('SimRegistrationService.approveStockItems', () => {
  it('approves a flagged item: clears flag, sets ADMIN_HELD, writes custody event', async () => {
    const item = makeItem()
    const tx = makeTx(item)
    const svc = new SimRegistrationService(makeDb(tx))

    const result = await svc.approveStockItems({
      organizationId: 'org_1',
      reviewedByStaffId: 'owner_1',
      serializedItemIds: ['item_1'],
    })

    expect(result.approved).toBe(1)

    // SerializedItem must be updated with flag cleared and custody set to ADMIN_HELD
    expect(tx.serializedItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item_1' },
        data: expect.objectContaining({
          requiresOwnerApproval: false,
          custodyState: 'ADMIN_HELD',
          ownerApprovedById: 'owner_1',
        }),
      }),
    )

    // A custody event must be written
    expect(tx.serializedItemCustodyEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serializedItemId: 'item_1',
          serialNumber: item.serialNumber,
          eventType: 'COLLECTED_FROM_SUPERVISOR',
          toState: 'ADMIN_HELD',
          actorStaffId: 'owner_1',
        }),
      }),
    )
  })

  it('skips an item that belongs to a different org', async () => {
    const item = makeItem({ organizationId: 'OTHER_ORG' })
    const tx = makeTx(item)
    const svc = new SimRegistrationService(makeDb(tx))

    const result = await svc.approveStockItems({
      organizationId: 'org_1',
      reviewedByStaffId: 'owner_1',
      serializedItemIds: ['item_1'],
    })

    expect(result.approved).toBe(0)
    expect(tx.serializedItem.update).not.toHaveBeenCalled()
    expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
  })

  it('skips an item that is not flagged for owner approval', async () => {
    const item = makeItem({ requiresOwnerApproval: false })
    const tx = makeTx(item)
    const svc = new SimRegistrationService(makeDb(tx))

    const result = await svc.approveStockItems({
      organizationId: 'org_1',
      reviewedByStaffId: 'owner_1',
      serializedItemIds: ['item_1'],
    })

    expect(result.approved).toBe(0)
    expect(tx.serializedItem.update).not.toHaveBeenCalled()
  })

  it('skips an item that is not found (null)', async () => {
    const tx = makeTx(null)
    const svc = new SimRegistrationService(makeDb(tx))

    const result = await svc.approveStockItems({
      organizationId: 'org_1',
      reviewedByStaffId: 'owner_1',
      serializedItemIds: ['item_missing'],
    })

    expect(result.approved).toBe(0)
  })

  it('bulk: approves multiple items and counts each independently', async () => {
    const item1 = makeItem({ id: 'item_1', serialNumber: '8952140000001234561' })
    const item2 = makeItem({ id: 'item_2', serialNumber: '8952140000001234562' })

    let callCount = 0
    const db = {
      $transaction: jest.fn().mockImplementation(async (fn: any) => {
        callCount++
        const item = callCount === 1 ? item1 : item2
        const tx = makeTx(item)
        return fn(tx)
      }),
    } as any

    const svc = new SimRegistrationService(db)
    const result = await svc.approveStockItems({
      organizationId: 'org_1',
      reviewedByStaffId: 'owner_1',
      serializedItemIds: ['item_1', 'item_2'],
    })

    expect(result.approved).toBe(2)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })
})
