/**
 * Unit tests for the ActivityLog dual-write bridge in SimCustodyService.
 *
 * Why: the SIM chain-of-custody (admin → supervisor → promoter → sold) records
 * every transfer into the dedicated `SerializedItemCustodyEvent` table, but wrote
 * ZERO rows to `ActivityLog`. The owner per-venue audit screen reads ActivityLog
 * (filtered by venueId), so the whole custody chain was invisible there.
 *
 * Fix: the shared `writeEvent` helper now ALSO fire-and-forgets a `logAction`
 * call (SIM_CUSTODY_<EVENT_TYPE>) right after the custody-event row is created.
 * Because every one of the 7-8 custody operations routes through `writeEvent`,
 * driving any two distinct ops proves all of them are bridged.
 *
 * `logAction` is globally mocked in tests/__helpers__/setup.ts to `jest.fn()`.
 *
 * DB-free: all Prisma calls are manually mocked.
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({
  notifySimCustody: jest.fn(),
}))

const mockedLogAction = logAction as unknown as jest.Mock

const ORG = 'org_1'
const SUPERVISOR = 'staff_supervisor'
const PROMOTER = 'staff_promoter'
const SELLING_VENUE = 'venue_selling'

function makeItem(overrides: any = {}) {
  return {
    id: 'item_1',
    venueId: null, // org-level item — venueId is null
    organizationId: ORG,
    sellingVenueId: SELLING_VENUE, // preferred venueId source for the audit log
    registeredFromVenueId: 'venue_registered',
    serialNumber: '8952140064023736375F',
    status: 'AVAILABLE',
    custodyState: 'ADMIN_HELD',
    assignedSupervisorId: null,
    assignedSupervisorAt: null,
    assignedPromoterId: null,
    assignedPromoterAt: null,
    promoterAcceptedAt: null,
    promoterRejectedAt: null,
    custodyVersion: 0,
    requiresOwnerApproval: false,
    ownerApprovedAt: null,
    ownerApprovedById: null,
    ...overrides,
  }
}

/**
 * Builds a SimCustodyService whose db mock returns `item` from findOrgItem and a
 * working updateWithVersion ($queryRaw) / event-create path so the happy path
 * reaches the dual-write. The updated row returned by $queryRaw is what
 * `writeEvent` receives as `e.item`, so we preserve the venue fields on it.
 */
function makeService(item: any) {
  const tx = {
    serializedItem: { findFirst: jest.fn().mockResolvedValue(item) },
    $queryRaw: jest.fn().mockImplementation(async () => [{ ...item, custodyVersion: (item?.custodyVersion ?? 0) + 1 }]),
    serializedItemCustodyEvent: { create: jest.fn().mockResolvedValue({ id: 'evt_1' }) },
    staffVenue: { findFirst: jest.fn().mockResolvedValue({ id: 'sv_1' }) },
  }
  const db = {
    staffOrganization: { findFirst: jest.fn().mockResolvedValue({ id: 'membership_1' }) },
    organization: { findUnique: jest.fn().mockResolvedValue({ simCustodyEnforcementMode: 'OFF' }) },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
  } as any
  return { service: new SimCustodyService(db), tx, db }
}

describe('SimCustodyService — ActivityLog dual-write bridge', () => {
  beforeEach(() => {
    mockedLogAction.mockClear()
  })

  // 1. NEW FEATURE TESTS
  it('assignToSupervisor writes a SIM_CUSTODY_ASSIGNED_TO_SUPERVISOR ActivityLog entry', async () => {
    const item = makeItem({ custodyState: 'ADMIN_HELD' })
    const { service, tx } = makeService(item)

    const res = await service.assignToSupervisor({
      actor: { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' },
      supervisorStaffId: SUPERVISOR,
      rows: [{ serialNumber: item.serialNumber }],
    })

    // Custody event row still written (existing behavior unbroken).
    expect(res.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
    expect(tx.serializedItemCustodyEvent.create).toHaveBeenCalledTimes(1)

    // New: ActivityLog dual-write fired with the right shape.
    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SIM_CUSTODY_ASSIGNED_TO_SUPERVISOR',
        entity: 'SerializedItem',
        entityId: item.id,
        staffId: 'owner_1', // the ACTOR
        venueId: SELLING_VENUE, // sellingVenueId preferred over the null venueId
        data: expect.objectContaining({
          serialNumber: item.serialNumber,
          toState: 'SUPERVISOR_HELD',
          toStaffId: SUPERVISOR,
        }),
      }),
    )
    const action = (mockedLogAction.mock.calls[0][0] as any).action as string
    expect(action.startsWith('SIM_CUSTODY_')).toBe(true)
  })

  it('collectFromPromoter writes a SIM_CUSTODY_COLLECTED_FROM_PROMOTER ActivityLog entry', async () => {
    // Promoter currently holds the SIM; supervisor (the actor) reclaims it.
    const item = makeItem({
      custodyState: 'PROMOTER_HELD',
      assignedSupervisorId: SUPERVISOR,
      assignedPromoterId: PROMOTER,
    })
    const { service, tx } = makeService(item)

    await service.collectFromPromoter({
      actor: { staffId: SUPERVISOR, organizationId: ORG, role: 'MANAGER' },
      serialNumber: item.serialNumber,
      reason: 'OTHER' as any,
    })

    expect(tx.serializedItemCustodyEvent.create).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SIM_CUSTODY_COLLECTED_FROM_PROMOTER',
        entity: 'SerializedItem',
        entityId: item.id,
        staffId: SUPERVISOR, // the ACTOR who collected
        venueId: SELLING_VENUE,
        data: expect.objectContaining({
          serialNumber: item.serialNumber,
          fromStaffId: PROMOTER,
          toStaffId: SUPERVISOR,
        }),
      }),
    )
  })

  // 2. REGRESSION / EDGE TESTS
  it('falls back to venueId when there is no selling/registration venue', async () => {
    const item = makeItem({
      custodyState: 'ADMIN_HELD',
      sellingVenueId: null,
      registeredFromVenueId: null,
      venueId: 'venue_legacy',
    })
    const { service } = makeService(item)

    await service.assignToSupervisor({
      actor: { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' },
      supervisorStaffId: SUPERVISOR,
      rows: [{ serialNumber: item.serialNumber }],
    })

    expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue_legacy' }))
  })

  it('does NOT write an ActivityLog entry when the custody op fails (no event row)', async () => {
    // Already SOLD → blocked before writeEvent runs.
    const item = makeItem({ status: 'SOLD', custodyState: 'ADMIN_HELD' })
    const { service, tx } = makeService(item)

    const res = await service.assignToSupervisor({
      actor: { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' },
      supervisorStaffId: SUPERVISOR,
      rows: [{ serialNumber: item.serialNumber }],
    })

    expect(res.summary).toMatchObject({ total: 1, succeeded: 0, failed: 1 })
    expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
    expect(mockedLogAction).not.toHaveBeenCalled()
  })
})
