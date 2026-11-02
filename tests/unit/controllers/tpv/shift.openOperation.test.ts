jest.mock('@/services/tpv/shift.tpv.service', () => ({ openShiftForVenue: jest.fn() }))

import { openShift } from '@/controllers/tpv/shift.tpv.controller'
import { openShiftForVenue } from '@/services/tpv/shift.tpv.service'

const OP = 'cm00000000000000000000003'
const call = (extra: Record<string, unknown> = {}, authExtra: Record<string, unknown> = {}) => {
  const req: any = {
    params: { venueId: 'venue-1' },
    authContext: { orgId: 'org-1', userId: 'actual-actor', terminalSerialNumber: 'AVQD-123', ...authExtra },
    body: { staffId: 'declared-only', startingCash: 500, ...extra },
  }
  const json = jest.fn()
  const status = jest.fn().mockReturnValue({ json })
  return { req, res: { status } as any, next: jest.fn(), status, json }
}
const contract = { operationId: OP, localId: OP, openedAt: '2026-10-27T14:00:00.000Z', isOfflineReplay: true }

beforeEach(() => {
  ;(openShiftForVenue as jest.Mock).mockResolvedValue({ id: 'shift-1', openingDisposition: 'ADOPTED' })
})

describe('TPV opening operation HTTP boundary', () => {
  it('uses the authenticated actor and serial, preserving the declared author only as evidence', async () => {
    const h = call(contract)
    await openShift(h.req, h.res, h.next)
    expect(openShiftForVenue).toHaveBeenCalledWith('venue-1', 'actual-actor', 500, undefined, 'org-1', {
      operationId: OP,
      localId: OP,
      openedAt: new Date(contract.openedAt),
      isOfflineReplay: true,
      terminalSerial: 'AVQD-123',
      declaredStaffId: 'declared-only',
    })
    expect(h.next).not.toHaveBeenCalled()
    expect(h.json).toHaveBeenCalledWith({ success: true, data: { id: 'shift-1', openingDisposition: 'ADOPTED' } })
  })

  it.each([
    ['invalid cuid', { operationId: 'not-a-cuid' }],
    ['invalid date', { openedAt: 'not-a-date' }],
    ['invalid replay flag', { isOfflineReplay: 'true' }],
    ['negative money', { startingCash: -1 }],
    ['out-of-range money', { startingCash: 100_000_000 }],
    ['string money', { startingCash: '500' }],
    ['missing local key', { localId: undefined }],
    ['missing operation', { operationId: undefined }],
  ])('rejects %s before invoking the service', async (_label, delta) => {
    const h = call({ ...contract, ...delta })
    await openShift(h.req, h.res, h.next)
    expect(openShiftForVenue).not.toHaveBeenCalled()
    expect(h.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
  })

  it('rejects distinct operationId/localId with the stable mismatch code', async () => {
    const h = call({ ...contract, localId: 'cm00000000000000000000004' })
    await openShift(h.req, h.res, h.next)
    expect(openShiftForVenue).not.toHaveBeenCalled()
    expect(h.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'SHIFT_OPERATION_CONTRACT_MISMATCH' }))
  })

  it('reports missing new fields in Spanish', async () => {
    const h = call({ ...contract, operationId: undefined })
    await openShift(h.req, h.res, h.next)
    expect(h.next.mock.calls[0][0].message).not.toContain('Required')
  })

  it.each([{ userId: undefined }, { terminalSerialNumber: undefined }])(
    'requires current authentication for new operations (%s)',
    async auth => {
      const h = call(contract, auth)
      await openShift(h.req, h.res, h.next)
      expect(openShiftForVenue).not.toHaveBeenCalled()
      expect(h.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
    },
  )

  it('REGRESSION: legacy retains its staffId authority and five-argument service call', async () => {
    const h = call()
    await openShift(h.req, h.res, h.next)
    expect(openShiftForVenue).toHaveBeenCalledWith('venue-1', 'declared-only', 500, undefined, 'org-1')
    expect(h.status).toHaveBeenCalledWith(201)
  })
})
