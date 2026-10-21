/**
 * Unit tests for SimCustodyService.collectFromSupervisorBulk
 *
 * Admin pastes a list of ICCIDs and every SIM a supervisor still holds goes
 * back to the admin warehouse (SUPERVISOR_HELD → ADMIN_HELD), one short
 * transaction per SIM, partial success reported per row.
 *
 * Scope decision (Isaac Mayoral, Asana 1219467533602693, 16-oct-2026 — "opción A"):
 * a SIM a promoter already carries is NOT collected; it comes back as
 * HAS_DOWNSTREAM_CUSTODY ("recolecta primero del Promotor"). The PROMOTER_*
 * cases below are the regression guard for that decision.
 *
 * DB-free: Prisma calls mocked inline (same pattern as custody.reassignSupervisor.service.test.ts).
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({
  notifySimCustody: jest.fn(),
}))
const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...a) }))

const ORG = 'org_1'
const SUPERVISOR = 'staff_supervisor'
const PROMOTER = 'staff_promoter'
const ACTOR = { staffId: 'admin_1', organizationId: ORG, role: 'ADMIN' as const }

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item_1',
    venueId: null,
    organizationId: ORG,
    serialNumber: 'SIM-X',
    status: 'AVAILABLE',
    custodyState: 'SUPERVISOR_HELD',
    assignedSupervisorId: SUPERVISOR,
    assignedSupervisorAt: new Date('2026-01-01T00:00:00Z'),
    assignedPromoterId: null,
    assignedPromoterAt: null,
    promoterAcceptedAt: null,
    promoterRejectedAt: null,
    custodyVersion: 3,
    requiresOwnerApproval: false,
    sellingVenueId: null,
    registeredFromVenueId: null,
    ...overrides,
  }
}

/** `items` maps serialNumber → item (missing key = not found in the org). */
function makeService(
  items: Record<string, ReturnType<typeof makeItem>>,
  opts: { versionConflict?: boolean; dbNow?: Record<string, Partial<ReturnType<typeof makeItem>>> } = {},
) {
  const tx = {
    serializedItem: {
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: { serialNumber: { equals: string } } }) => {
        return items[where.serialNumber.equals] ?? null
      }),
    },
    $queryRaw: jest.fn().mockImplementation(async (_strings: unknown, ...values: unknown[]) => {
      if (opts.versionConflict) return []
      const id = values[7]
      const item = Object.values(items).find(i => i.id === id)
      if (!item) return []
      // Evaluate the WHERE like Postgres would, against the row as it is NOW (another writer
      // may have changed it after our read without bumping custodyVersion — e.g. markAsSold).
      const now = { ...item, ...(opts.dbNow?.[item.serialNumber] ?? {}) }
      const [, , , , , , , , version, status, state] = values
      if (now.custodyVersion !== version) return []
      if (status !== undefined && now.status !== status) return []
      if (state !== undefined && now.custodyState !== state) return []
      return [{ ...now, custodyState: values[0], custodyVersion: now.custodyVersion + 1 }]
    }),
    serializedItemCustodyEvent: { create: jest.fn().mockResolvedValue({ id: 'evt_1' }) },
  }
  const db = {
    $transaction: jest.fn().mockImplementation(async (fn: (txClient: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as import('@prisma/client').PrismaClient

  return { service: new SimCustodyService(db), tx }
}

/** Values bound into updateWithVersion's UPDATE (fixed SET order, see custody.service.ts). */
function updatePayload(tx: { $queryRaw: jest.Mock }, callIndex = 0) {
  const [, custodyState, assignedSupervisorId, assignedSupervisorAt, assignedPromoterId] = tx.$queryRaw.mock.calls[callIndex]
  const unwrap = (bind: unknown) => {
    if (bind && typeof bind === 'object' && 'strings' in bind && 'values' in bind) {
      const f = bind as { strings: string[]; values: unknown[] }
      return f.strings.join('').trim() === 'NULL::timestamp' ? null : f.values[0]
    }
    return bind
  }
  return { custodyState, assignedSupervisorId, assignedSupervisorAt: unwrap(assignedSupervisorAt), assignedPromoterId }
}

describe('SimCustodyService — collectFromSupervisorBulk', () => {
  describe('happy path', () => {
    it('returns every SUPERVISOR_HELD sim to the admin warehouse', async () => {
      const { service, tx } = makeService({
        'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }),
        'SIM-2': makeItem({ id: 'i2', serialNumber: 'SIM-2' }),
      })

      const res = await service.collectFromSupervisorBulk({
        actor: ACTOR,
        serialNumbers: ['SIM-1', 'SIM-2'],
        reason: 'SUPERVISOR_COLLECTION',
      })

      expect(res.summary).toEqual({ total: 2, succeeded: 2, failed: 0 })
      expect(res.results.map(r => r.status)).toEqual(['ok', 'ok'])
      expect(res.results[0].event).toBe('COLLECTED_FROM_SUPERVISOR')

      const payload = updatePayload(tx)
      expect(payload.custodyState).toBe('ADMIN_HELD')
      expect(payload.assignedSupervisorId).toBeNull()
      expect(payload.assignedSupervisorAt).toBeNull()
    })

    it('writes one custody event per sim with the reason and both actors', async () => {
      const { service, tx } = makeService({ 'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }) })

      await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'STAFF_TERMINATED' })

      expect(tx.serializedItemCustodyEvent.create).toHaveBeenCalledTimes(1)
      expect(tx.serializedItemCustodyEvent.create.mock.calls[0][0].data).toMatchObject({
        eventType: 'COLLECTED_FROM_SUPERVISOR',
        fromState: 'SUPERVISOR_HELD',
        toState: 'ADMIN_HELD',
        fromStaffId: SUPERVISOR,
        toStaffId: ACTOR.staffId,
        actorStaffId: ACTOR.staffId,
        reason: 'STAFF_TERMINATED',
      })
    })

    it('the audit row carries the organization, so SIMs with no store still show in the org log (Codex r1 #6)', async () => {
      const { service } = makeService({ 'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }) })
      await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'SUPERVISOR_COLLECTION' })
      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SIM_CUSTODY_COLLECTED_FROM_SUPERVISOR',
          organizationId: ORG,
          venueId: null,
          staffId: ACTOR.staffId,
        }),
      )
    })

    it('stamps the idempotency request id on the event', async () => {
      const { service, tx } = makeService({ 'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }) })

      await service.collectFromSupervisorBulk({
        actor: ACTOR,
        serialNumbers: ['SIM-1'],
        reason: 'SUPERVISOR_COLLECTION',
        idempotencyRequestId: 'req_1',
      })

      expect(tx.serializedItemCustodyEvent.create.mock.calls[0][0].data.idempotencyRequestId).toBe('req_1')
    })
  })

  describe('idempotency', () => {
    it('a sim already in the admin warehouse is ok and writes nothing (pasting the same list twice)', async () => {
      const { service, tx } = makeService({
        'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1', custodyState: 'ADMIN_HELD', assignedSupervisorId: null }),
      })

      const res = await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'SUPERVISOR_COLLECTION' })

      expect(res.results[0]).toMatchObject({ serialNumber: 'SIM-1', status: 'ok' })
      expect(tx.$queryRaw).not.toHaveBeenCalled()
      expect(tx.serializedItemCustodyEvent.create).not.toHaveBeenCalled()
    })
  })

  describe('rejections (per row, the rest keep going)', () => {
    it.each(['PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED'])(
      '%s is NOT collected — Isaac "opción A": collect from the promoter first',
      async custodyState => {
        const { service, tx } = makeService({
          'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1', custodyState, assignedPromoterId: PROMOTER }),
        })

        const res = await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'SUPERVISOR_COLLECTION' })

        expect(res.results[0]).toMatchObject({ status: 'error', code: 'HAS_DOWNSTREAM_CUSTODY' })
        expect(res.results[0].message).toMatch(/Promotor/)
        expect(tx.$queryRaw).not.toHaveBeenCalled()
      },
    )

    it('unknown ICCID → NOT_FOUND', async () => {
      const { service } = makeService({})
      const res = await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['NOPE'], reason: 'SUPERVISOR_COLLECTION' })
      expect(res.results[0]).toMatchObject({ serialNumber: 'NOPE', status: 'error', code: 'NOT_FOUND' })
    })

    it('sold sim → SIM_SOLD', async () => {
      const { service, tx } = makeService({
        'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1', status: 'SOLD', custodyState: 'SOLD' }),
      })
      const res = await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'SUPERVISOR_COLLECTION' })
      expect(res.results[0]).toMatchObject({ status: 'error', code: 'SIM_SOLD' })
      expect(tx.$queryRaw).not.toHaveBeenCalled()
    })

    it('concurrent change → VERSION_CONFLICT on that row only', async () => {
      const { service } = makeService({ 'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }) }, { versionConflict: true })
      const res = await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'SUPERVISOR_COLLECTION' })
      expect(res.results[0]).toMatchObject({ status: 'error', code: 'VERSION_CONFLICT' })
    })

    it('a manual sale that lands between our read and our write → VERSION_CONFLICT, never SOLD + ADMIN_HELD (Codex r1 #2)', async () => {
      // markAsSold flips status/custodyState WITHOUT bumping custodyVersion, so the version alone
      // used to let the collect overwrite a sold SIM back into the warehouse.
      const { service } = makeService(
        { 'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }) },
        { dbNow: { 'SIM-1': { status: 'SOLD', custodyState: 'SOLD' } } },
      )
      const res = await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'SUPERVISOR_COLLECTION' })
      expect(res.results[0]).toMatchObject({ status: 'error', code: 'VERSION_CONFLICT' })
    })

    it('mixed list: partial success, one row per serial, in input order', async () => {
      const { service } = makeService({
        'SIM-OK': makeItem({ id: 'i1', serialNumber: 'SIM-OK' }),
        'SIM-PROMO': makeItem({ id: 'i2', serialNumber: 'SIM-PROMO', custodyState: 'PROMOTER_HELD', assignedPromoterId: PROMOTER }),
      })

      const res = await service.collectFromSupervisorBulk({
        actor: ACTOR,
        serialNumbers: ['SIM-OK', 'SIM-PROMO', 'SIM-MISSING'],
        reason: 'SUPERVISOR_COLLECTION',
      })

      expect(res.summary).toEqual({ total: 3, succeeded: 1, failed: 2 })
      expect(res.results.map(r => [r.serialNumber, r.status, r.code])).toEqual([
        ['SIM-OK', 'ok', undefined],
        ['SIM-PROMO', 'error', 'HAS_DOWNSTREAM_CUSTODY'],
        ['SIM-MISSING', 'error', 'NOT_FOUND'],
      ])
    })
  })

  describe('tenant isolation', () => {
    it('looks each serial up inside the actor org only', async () => {
      const { service, tx } = makeService({ 'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }) })
      await service.collectFromSupervisorBulk({ actor: ACTOR, serialNumbers: ['SIM-1'], reason: 'SUPERVISOR_COLLECTION' })
      expect(tx.serializedItem.findFirst.mock.calls[0][0].where.organizationId).toBe(ORG)
    })
  })

  // ── Regression: the single-SIM collect keeps its old behavior ────────────────
  describe('regression — collectFromSupervisor (one SIM)', () => {
    it('still collects a SUPERVISOR_HELD sim', async () => {
      const { service, tx } = makeService({ 'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1' }) })
      const res = await service.collectFromSupervisor({ actor: ACTOR, serialNumber: 'SIM-1', reason: 'DAMAGED_SIM' })
      expect(res).toEqual({ custodyState: 'ADMIN_HELD' })
      expect(tx.serializedItemCustodyEvent.create.mock.calls[0][0].data.reason).toBe('DAMAGED_SIM')
    })

    it('still rejects a sim already in the admin warehouse (no silent no-op on the single path)', async () => {
      const { service } = makeService({
        'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1', custodyState: 'ADMIN_HELD', assignedSupervisorId: null }),
      })
      await expect(service.collectFromSupervisor({ actor: ACTOR, serialNumber: 'SIM-1', reason: 'DAMAGED_SIM' })).rejects.toMatchObject({
        code: 'HAS_DOWNSTREAM_CUSTODY',
      })
    })

    it('still rejects a sim a promoter carries', async () => {
      const { service } = makeService({
        'SIM-1': makeItem({ id: 'i1', serialNumber: 'SIM-1', custodyState: 'PROMOTER_HELD', assignedPromoterId: PROMOTER }),
      })
      await expect(service.collectFromSupervisor({ actor: ACTOR, serialNumber: 'SIM-1', reason: 'DAMAGED_SIM' })).rejects.toMatchObject({
        code: 'HAS_DOWNSTREAM_CUSTODY',
      })
    })
  })
})
