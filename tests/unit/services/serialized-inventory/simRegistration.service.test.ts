import { Prisma } from '@prisma/client'
import { SimRegistrationService } from '@/services/serialized-inventory/simRegistration.service'

function makeDb(overrides: any = {}) {
  return {
    organization: { findUnique: jest.fn().mockResolvedValue({ simCustodyEnforcementMode: 'ENFORCE' }) },
    serializedItem: { findMany: jest.fn().mockResolvedValue([]) },
    simRegistrationRequest: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'req_1', ...data })),
    },
    simRegistrationRequestItem: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides,
  } as any
}

describe('SimRegistrationService.isApprovalModeEnabled', () => {
  it('returns true when org is ENFORCE', async () => {
    expect(await new SimRegistrationService(makeDb()).isApprovalModeEnabled('org_1')).toBe(true)
  })
  it('returns false when org is OFF', async () => {
    const db = makeDb({ organization: { findUnique: jest.fn().mockResolvedValue({ simCustodyEnforcementMode: 'OFF' }) } })
    expect(await new SimRegistrationService(db).isApprovalModeEnabled('org_1')).toBe(false)
  })
  it('returns false when org missing', async () => {
    const db = makeDb({ organization: { findUnique: jest.fn().mockResolvedValue(null) } })
    expect(await new SimRegistrationService(db).isApprovalModeEnabled('org_x')).toBe(false)
  })
})

describe('SimRegistrationService.createRequest', () => {
  it('returns bad-format ICCIDs in `invalid` and does not submit them', async () => {
    const res = await new SimRegistrationService(makeDb()).createRequest({
      organizationId: 'org_1',
      requestedByStaffId: 'staff_1',
      registeredFromVenueId: 'venue_1',
      proposedCategoryId: 'cat_1',
      serialNumbers: ['BADFORMAT123'],
    })
    expect(res.invalid).toContain('BADFORMAT123')
    expect(res.submitted).toBe(0)
  })
  it('marks already-existing SerializedItems as duplicates', async () => {
    const db = makeDb({ serializedItem: { findMany: jest.fn().mockResolvedValue([{ serialNumber: '8952140000001234567' }]) } })
    const res = await new SimRegistrationService(db).createRequest({
      organizationId: 'org_1',
      requestedByStaffId: 'staff_1',
      registeredFromVenueId: 'venue_1',
      proposedCategoryId: 'cat_1',
      serialNumbers: ['8952140000001234567'],
    })
    expect(res.duplicates).toContain('8952140000001234567')
    expect(res.submitted).toBe(0)
  })
  it('creates a request for valid new ICCIDs', async () => {
    const res = await new SimRegistrationService(makeDb()).createRequest({
      organizationId: 'org_1',
      requestedByStaffId: 'staff_1',
      registeredFromVenueId: 'venue_1',
      proposedCategoryId: 'cat_1',
      serialNumbers: ['8952140000001234567', '89521400000012345678'],
    })
    expect(res.submitted).toBe(2)
    expect(res.requestId).toBeTruthy()
  })
})

function makeApproveDb(items: any[], orgItems: any[] = []) {
  const txStub = {
    simRegistrationRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'req_1',
        organizationId: 'org_1',
        requestedByStaffId: 'staff_1',
        registeredFromVenueId: 'venue_1',
        proposedCategoryId: 'cat_1',
        status: 'PENDING',
        items,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    simRegistrationRequestItem: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue(items.map((it: any) => ({ status: it._finalStatus ?? it.status }))),
    },
    serializedItem: {
      findMany: jest.fn().mockResolvedValue(orgItems),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'item_new', ...data })),
    },
  }
  const db: any = { $transaction: jest.fn().mockImplementation(async (fn: any) => fn(txStub)) }
  return { db, txStub }
}

describe('SimRegistrationService.approve', () => {
  it('creates a SerializedItem in ADMIN_HELD per approved item and marks item APPROVED', async () => {
    const { db, txStub } = makeApproveDb([{ id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING', _finalStatus: 'APPROVED' }])
    const res = await new (require('@/services/serialized-inventory/simRegistration.service').SimRegistrationService)(db).approve({
      organizationId: 'org_1',
      requestId: 'req_1',
      reviewedByStaffId: 'owner_1',
      categoryId: 'cat_1',
    })
    expect(txStub.serializedItem.create).toHaveBeenCalledTimes(1)
    const createArg = txStub.serializedItem.create.mock.calls[0][0].data
    expect(createArg.custodyState).toBe('ADMIN_HELD')
    expect(createArg.organizationId).toBe('org_1')
    expect(createArg.createdBy).toBe('staff_1')
    expect(res.approved).toBe(1)
  })

  it('skips items that already exist as SerializedItem (marks DUPLICATE, no create)', async () => {
    const { db, txStub } = makeApproveDb(
      [{ id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING', _finalStatus: 'DUPLICATE' }],
      [{ serialNumber: '8952140000001234567' }],
    )
    const res = await new (require('@/services/serialized-inventory/simRegistration.service').SimRegistrationService)(db).approve({
      organizationId: 'org_1',
      requestId: 'req_1',
      reviewedByStaffId: 'owner_1',
      categoryId: 'cat_1',
    })
    expect(txStub.serializedItem.create).not.toHaveBeenCalled()
    expect(res.approved).toBe(0)
    expect(res.duplicates).toBe(1)
  })

  it('throws REQUEST_NOT_FOUND when request belongs to another org', async () => {
    const { db } = makeApproveDb([{ id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING' }])
    db.$transaction = jest.fn().mockImplementation(async (fn: any) =>
      fn({
        simRegistrationRequest: { findUnique: jest.fn().mockResolvedValue({ id: 'req_1', organizationId: 'OTHER', items: [] }) },
      }),
    )
    await expect(
      new (require('@/services/serialized-inventory/simRegistration.service').SimRegistrationService)(db).approve({
        organizationId: 'org_1',
        requestId: 'req_1',
        reviewedByStaffId: 'owner_1',
        categoryId: 'cat_1',
      }),
    ).rejects.toThrow('REQUEST_NOT_FOUND')
  })
})

describe('SimRegistrationService.reject', () => {
  it('marks items REJECTED with reason and creates no SerializedItem', async () => {
    const { db, txStub } = makeApproveDb([{ id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING', _finalStatus: 'REJECTED' }])
    const res = await new (require('@/services/serialized-inventory/simRegistration.service').SimRegistrationService)(db).reject({
      organizationId: 'org_1',
      requestId: 'req_1',
      reviewedByStaffId: 'owner_1',
      reason: 'ICCID ilegible',
    })
    expect(txStub.serializedItem.create).not.toHaveBeenCalled()
    expect(txStub.simRegistrationRequestItem.update).toHaveBeenCalled()
    expect(res.rejected).toBe(1)
  })
})

describe('SimRegistrationService.createRequest — case-insensitive dedup (Fix 1)', () => {
  it('treats stored lowercase serialNumber as duplicate of uppercase input', async () => {
    // Stored item has lowercase hex suffix; input is uppercased by normalizeSerial.
    // Without the fix, existingSet.has('8952140000001234567F') would miss '8952140000001234567f'.
    const db = makeDb({
      serializedItem: {
        findMany: jest.fn().mockResolvedValue([{ serialNumber: '8952140000001234567f' }]),
      },
    })
    const res = await new SimRegistrationService(db).createRequest({
      organizationId: 'org_1',
      requestedByStaffId: 'staff_1',
      serialNumbers: ['8952140000001234567F'],
    })
    expect(res.duplicates).toContain('8952140000001234567F')
    expect(res.submitted).toBe(0)
  })
})

describe('SimRegistrationService.approve — P2002 race (Fix 2)', () => {
  it('counts concurrent-created item as duplicate, does not reject, does not write item status', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on (organizationId, serialNumber)', {
      code: 'P2002',
      clientVersion: 'test',
    })
    const { db, txStub } = makeApproveDb([{ id: 'it_1', serialNumber: '8952140000001234567', status: 'PENDING', _finalStatus: 'APPROVED' }])
    // Override create to throw P2002, simulating a concurrent insert race.
    txStub.serializedItem.create = jest.fn().mockRejectedValue(p2002)
    const res = await new SimRegistrationService(db).approve({
      organizationId: 'org_1',
      requestId: 'req_1',
      reviewedByStaffId: 'owner_1',
      categoryId: 'cat_1',
    })
    expect(res.approved).toBe(0)
    expect(res.duplicates).toBe(1)
    // The item status must NOT have been updated in the same tx after the P2002
    // (a P2002 may abort the Postgres tx; any further write in that tx would also fail).
    expect(txStub.simRegistrationRequestItem.update).not.toHaveBeenCalled()
  })
})
