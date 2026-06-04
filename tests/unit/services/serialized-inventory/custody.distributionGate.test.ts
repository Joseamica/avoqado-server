/**
 * Unit tests for the owner-approval DISTRIBUTION gate in SimCustodyService.
 *
 * Root cause (2026-06-04): the sale gate (applyCustodyPrecheck) blocks a flagged
 * SIM (`requiresOwnerApproval=true`) only at SALE time, but the distribution
 * methods (assignToSupervisor / assignToPromoter / assignToPromoterDirect) never
 * checked the flag. Unapproved stock therefore flowed all the way down to a
 * promoter, who accepted it (PROMOTER_HELD) and then could NOT sell it — a
 * dead-end that surfaced as the misleading "SIM no aceptado" dialog.
 *
 * Fix: block distribution of a flagged SIM at assignment time (ENFORCE mode),
 * with the dedicated REQUIRES_OWNER_APPROVAL code, so it never reaches the
 * promoter unapproved.
 *
 * DB-free: all Prisma calls are manually mocked.
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({
  notifySimCustody: jest.fn(),
}))

const ORG = 'org_1'
const SUPERVISOR = 'staff_supervisor'
const PROMOTER = 'staff_promoter'

function makeItem(overrides: any = {}) {
  return {
    id: 'item_1',
    venueId: null,
    organizationId: ORG,
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
 * Builds a SimCustodyService whose db mock returns `item` from findOrgItem,
 * the given enforcement `mode`, and a working updateWithVersion/event path so
 * the ALLOWED (non-blocked) cases reach a successful row.
 */
function makeService(item: any, mode: 'OFF' | 'WARN' | 'ENFORCE') {
  const tx = {
    serializedItem: { findFirst: jest.fn().mockResolvedValue(item) },
    // updateWithVersion uses tx.$queryRaw → returns the updated row.
    $queryRaw: jest.fn().mockResolvedValue([{ ...item, custodyVersion: (item?.custodyVersion ?? 0) + 1 }]),
    serializedItemCustodyEvent: { create: jest.fn().mockResolvedValue({ id: 'evt_1' }) },
  }
  const db = {
    staffOrganization: { findFirst: jest.fn().mockResolvedValue({ id: 'membership_1' }) },
    organization: { findUnique: jest.fn().mockResolvedValue({ simCustodyEnforcementMode: mode }) },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
  } as any
  return { service: new SimCustodyService(db), tx, db }
}

describe('SimCustodyService — owner-approval distribution gate', () => {
  describe('blocks distribution of flagged stock in ENFORCE mode', () => {
    it('assignToSupervisor: flagged ADMIN_HELD → REQUIRES_OWNER_APPROVAL, no state change', async () => {
      const item = makeItem({ requiresOwnerApproval: true, custodyState: 'ADMIN_HELD' })
      const { service, tx } = makeService(item, 'ENFORCE')

      const res = await service.assignToSupervisor({
        actor: { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' },
        supervisorStaffId: SUPERVISOR,
        rows: [{ serialNumber: item.serialNumber }],
      })

      expect(res.summary).toMatchObject({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('REQUIRES_OWNER_APPROVAL')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
      expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
    })

    it('assignToPromoter: flagged SUPERVISOR_HELD → REQUIRES_OWNER_APPROVAL', async () => {
      const item = makeItem({
        requiresOwnerApproval: true,
        custodyState: 'SUPERVISOR_HELD',
        assignedSupervisorId: SUPERVISOR,
      })
      const { service, tx } = makeService(item, 'ENFORCE')

      const res = await service.assignToPromoter({
        actor: { staffId: SUPERVISOR, organizationId: ORG, role: 'MANAGER' },
        promoterStaffId: PROMOTER,
        serialNumbers: [item.serialNumber],
      })

      expect(res.summary).toMatchObject({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('REQUIRES_OWNER_APPROVAL')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('assignToPromoterDirect: flagged ADMIN_HELD → REQUIRES_OWNER_APPROVAL', async () => {
      const item = makeItem({ requiresOwnerApproval: true, custodyState: 'ADMIN_HELD' })
      const { service, tx } = makeService(item, 'ENFORCE')

      const res = await service.assignToPromoterDirect({
        actor: { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' },
        promoterStaffId: PROMOTER,
        serialNumbers: [item.serialNumber],
      })

      expect(res.summary).toMatchObject({ total: 1, succeeded: 0, failed: 1 })
      expect(res.results[0].code).toBe('REQUIRES_OWNER_APPROVAL')
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })
  })

  describe('regression — does NOT block legitimate distribution', () => {
    it('assignToSupervisor: NON-flagged ADMIN_HELD → succeeds (event written)', async () => {
      const item = makeItem({ requiresOwnerApproval: false, custodyState: 'ADMIN_HELD' })
      const { service, tx } = makeService(item, 'ENFORCE')

      const res = await service.assignToSupervisor({
        actor: { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' },
        supervisorStaffId: SUPERVISOR,
        rows: [{ serialNumber: item.serialNumber }],
      })

      expect(res.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
      expect(tx.serializedItemCustodyEvent.create).toHaveBeenCalled()
    })

    it('OFF mode: flagged item is NOT blocked (gate is ENFORCE-only)', async () => {
      const item = makeItem({ requiresOwnerApproval: true, custodyState: 'ADMIN_HELD' })
      const { service } = makeService(item, 'OFF')

      const res = await service.assignToSupervisor({
        actor: { staffId: 'owner_1', organizationId: ORG, role: 'OWNER' },
        supervisorStaffId: SUPERVISOR,
        rows: [{ serialNumber: item.serialNumber }],
      })

      expect(res.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
    })
  })
})
