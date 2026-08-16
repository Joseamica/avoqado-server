import {
  normalizeTenderName,
  SYSTEM_TENDER_SEEDS,
  ensureSystemTenderTypes,
  createTenderType,
  updateTenderType,
  listTenderTypes,
} from '@/services/dashboard/tenderType.dashboard.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { prismaMock } from '../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const VENUE = 'venue-1'
const STAFF = 'staff-1'

/**
 * VenueTenderType catalog (slice A1) — the invariants here were the exact NO-GO findings
 * of the v1–v4 adversarial audits, so every one of them gets a regression test:
 * custom rows can NEVER pick their own baseMethod (always OTHER), money-semantic edits
 * append an immutable revision row in the SAME transaction, '99' is not a valid SAT
 * forma, system rows are immutable in their money semantics, and every lookup is
 * venue-scoped (composite identity).
 */
describe('tenderType.dashboard.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venueTenderType.create.mockImplementation(async (args: any) => ({ id: 'tt-1', revision: 1, ...args.data }))
    prismaMock.venueTenderTypeRevision.create.mockResolvedValue({ id: 'rev-1' })
    prismaMock.venueTenderType.count.mockResolvedValue(0)
    prismaMock.venueTenderType.findFirst.mockResolvedValue(null)
    prismaMock.venueTenderType.findMany.mockResolvedValue([])
    prismaMock.venueTenderType.updateMany.mockResolvedValue({ count: 1 })
  })

  describe('normalizeTenderName', () => {
    it('lowercases, trims, strips accents and collapses inner spaces', () => {
      expect(normalizeTenderName('  Über  Eats ')).toBe('uber eats')
      expect(normalizeTenderName('Tarjeta de crédito')).toBe('tarjeta de credito')
      expect(normalizeTenderName('UBER EATS')).toBe(normalizeTenderName('uber eats'))
    })
  })

  describe('createTenderType', () => {
    it('custom rows ALWAYS get baseMethod OTHER and a server-computed normalizedName', async () => {
      // Even a hostile caller passing baseMethod must not be able to override it.
      await createTenderType(VENUE, { name: '  Uber  Eats ', baseMethod: 'BANK_TRANSFER' } as any, STAFF)

      const data = prismaMock.venueTenderType.create.mock.calls[0][0].data
      expect(data.baseMethod).toBe('OTHER')
      expect(data.isSystem).toBe(false)
      expect(data.name).toBe('Uber Eats')
      expect(data.normalizedName).toBe('uber eats')
      expect(data.revision).toBe(1)
    })

    it('appends the frozen revision row (revision 1) in the same transaction', async () => {
      await createTenderType(VENUE, { name: 'Vale de despensa', countsAsPhysicalCash: true, satFormaPago: '05' }, STAFF)

      expect(prismaMock.$transaction).toHaveBeenCalled()
      const rev = prismaMock.venueTenderTypeRevision.create.mock.calls[0][0].data
      expect(rev).toMatchObject({
        venueId: VENUE,
        tenderTypeId: 'tt-1',
        revision: 1,
        countsAsPhysicalCash: true,
        satFormaPago: '05',
        createdBy: STAFF,
      })
    })

    it("rejects satFormaPago '99' and codes outside the SAT catalog", async () => {
      await expect(createTenderType(VENUE, { name: 'X', satFormaPago: '99' })).rejects.toThrow(BadRequestError)
      await expect(createTenderType(VENUE, { name: 'X', satFormaPago: '77' })).rejects.toThrow(BadRequestError)
      expect(prismaMock.venueTenderType.create).not.toHaveBeenCalled()
    })

    it('rejects commissionPercent outside 0..100', async () => {
      await expect(createTenderType(VENUE, { name: 'X', commissionPercent: 101 })).rejects.toThrow(BadRequestError)
      await expect(createTenderType(VENUE, { name: 'X', commissionPercent: -1 })).rejects.toThrow(BadRequestError)
    })

    it('maps the unique-name violation (P2002) to a ConflictError', async () => {
      prismaMock.venueTenderType.create.mockRejectedValue({ code: 'P2002' })

      await expect(createTenderType(VENUE, { name: 'Uber Eats' })).rejects.toThrow(ConflictError)
    })

    it('writes the audit trail entry', async () => {
      await createTenderType(VENUE, { name: 'Rappi' }, STAFF)

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'TENDER_TYPE_CREATED', entity: 'VenueTenderType', venueId: VENUE, staffId: STAFF }),
      )
    })
  })

  describe('updateTenderType', () => {
    const existingCustom = {
      id: 'tt-1',
      venueId: VENUE,
      isSystem: false,
      revision: 3,
      name: 'Uber Eats',
      countsAsPhysicalCash: false,
      captureTip: true,
      commissionPercent: null,
      satFormaPago: null,
    }

    it('is venue-scoped: a tender from another venue is NotFound, never touched', async () => {
      prismaMock.venueTenderType.findFirst.mockResolvedValue(null)

      await expect(updateTenderType('venue-OTRO', 'tt-1', 3, { name: 'Hack' })).rejects.toThrow(NotFoundError)
      expect(prismaMock.venueTenderType.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tt-1', venueId: 'venue-OTRO' } }),
      )
      expect(prismaMock.venueTenderType.updateMany).not.toHaveBeenCalled()
    })

    it('money-semantic edit: optimistic precondition on revision, bump, and frozen revision row', async () => {
      prismaMock.venueTenderType.findFirst
        .mockResolvedValueOnce(existingCustom as any) // existence check
        .mockResolvedValueOnce({ ...existingCustom, revision: 4, commissionPercent: '30.00' } as any) // re-read after bump
      await updateTenderType(VENUE, 'tt-1', 3, { commissionPercent: 30 }, STAFF)

      const um = prismaMock.venueTenderType.updateMany.mock.calls[0][0]
      expect(um.where).toMatchObject({ id: 'tt-1', venueId: VENUE, revision: 3 })
      expect(um.data.revision).toEqual({ increment: 1 })
      const rev = prismaMock.venueTenderTypeRevision.create.mock.calls[0][0].data
      expect(rev).toMatchObject({ tenderTypeId: 'tt-1', revision: 4, createdBy: STAFF })
    })

    it('presentation-only edit (order/section/showOnPos/active) does NOT bump nor append a revision', async () => {
      prismaMock.venueTenderType.findFirst.mockResolvedValue(existingCustom as any)

      await updateTenderType(VENUE, 'tt-1', 3, { displayOrder: 7, posSection: 'PRIMARY' as any, active: false })

      const um = prismaMock.venueTenderType.updateMany.mock.calls[0][0]
      expect(um.data.revision).toBeUndefined()
      expect(prismaMock.venueTenderTypeRevision.create).not.toHaveBeenCalled()
    })

    it('a concurrent edit loses the optimistic race and gets a 409, not a silent overwrite', async () => {
      prismaMock.venueTenderType.findFirst.mockResolvedValue(existingCustom as any)
      prismaMock.venueTenderType.updateMany.mockResolvedValue({ count: 0 })

      await expect(updateTenderType(VENUE, 'tt-1', 3, { name: 'Nuevo' })).rejects.toThrow(ConflictError)
      expect(prismaMock.venueTenderTypeRevision.create).not.toHaveBeenCalled()
    })

    it('system rows reject money-semantic edits but allow presentation edits', async () => {
      const system = { ...existingCustom, isSystem: true, name: 'Efectivo' }
      prismaMock.venueTenderType.findFirst.mockResolvedValue(system as any)

      await expect(updateTenderType(VENUE, 'tt-1', 3, { name: 'Cash money' })).rejects.toThrow(BadRequestError)
      await expect(updateTenderType(VENUE, 'tt-1', 3, { commissionPercent: 5 })).rejects.toThrow(BadRequestError)

      await updateTenderType(VENUE, 'tt-1', 3, { posSection: 'MORE' as any, displayOrder: 2 })
      expect(prismaMock.venueTenderType.updateMany).toHaveBeenCalledTimes(1)
    })
  })

  describe('ensureSystemTenderTypes', () => {
    it('seeds the 4 system tenders with their frozen revision rows when missing', async () => {
      prismaMock.venueTenderType.count.mockResolvedValue(0)
      prismaMock.venueTenderType.findFirst.mockResolvedValue(null)

      await ensureSystemTenderTypes(VENUE)

      expect(prismaMock.venueTenderType.create).toHaveBeenCalledTimes(SYSTEM_TENDER_SEEDS.length)
      expect(prismaMock.venueTenderTypeRevision.create).toHaveBeenCalledTimes(SYSTEM_TENDER_SEEDS.length)
      const methods = prismaMock.venueTenderType.create.mock.calls.map((c: any) => c[0].data.baseMethod)
      expect(methods).toEqual(expect.arrayContaining(['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER']))
      // Cash is the only one that physically enters the drawer, and every system row is isSystem.
      const cash = prismaMock.venueTenderType.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.baseMethod === 'CASH')
      expect(cash.countsAsPhysicalCash).toBe(true)
      expect(cash.isSystem).toBe(true)
      expect(cash.satFormaPago).toBe('01')
    })

    it('fast-path: does nothing when the venue already has its system rows', async () => {
      prismaMock.venueTenderType.count.mockResolvedValue(SYSTEM_TENDER_SEEDS.length)

      await ensureSystemTenderTypes(VENUE)

      expect(prismaMock.venueTenderType.create).not.toHaveBeenCalled()
    })

    it('a concurrent seeder winning the race (P2002) is silently tolerated, never a 500', async () => {
      prismaMock.venueTenderType.count.mockResolvedValue(0)
      prismaMock.venueTenderType.findFirst.mockResolvedValue(null)
      prismaMock.venueTenderType.create.mockRejectedValue({ code: 'P2002' })

      await expect(ensureSystemTenderTypes(VENUE)).resolves.toBeUndefined()
    })
  })

  describe('listTenderTypes', () => {
    it('lazy-seeds first, then returns the venue catalog in stable section/order/id order', async () => {
      prismaMock.venueTenderType.count.mockResolvedValue(SYSTEM_TENDER_SEEDS.length)
      prismaMock.venueTenderType.findMany.mockResolvedValue([{ id: 'tt-1' }] as any)

      const out = await listTenderTypes(VENUE)

      expect(prismaMock.venueTenderType.count).toHaveBeenCalled() // ensure ran (fast-path)
      const q = prismaMock.venueTenderType.findMany.mock.calls[0][0]
      expect(q.where).toEqual({ venueId: VENUE })
      // Stable orderBy (paginación-inestable guard): id as final tiebreak.
      expect(q.orderBy[q.orderBy.length - 1]).toEqual({ id: 'asc' })
      expect(out).toEqual([{ id: 'tt-1' }])
    })
  })
})
