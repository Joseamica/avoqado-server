/**
 * Close-shift HTTP boundary contract.
 *
 * Production change that makes these tests pass: the controller must forward the raw additive
 * close body to the reconciliation-aware service, preserve the authenticated actor, and keep the
 * Shift response under `data` while adding request-scoped reconciliation metadata at the root.
 */

const closeShiftForVenueWithResult = jest.fn()

jest.mock('@/services/tpv/shift.tpv.service', () => ({
  closeShiftForVenueWithResult: (...args: unknown[]) => closeShiftForVenueWithResult(...args),
}))

import { closeShift } from '@/controllers/tpv/shift.tpv.controller'

function makeHttp(body: unknown) {
  const json = jest.fn()
  const status = jest.fn().mockReturnValue({ json })
  const next = jest.fn()
  const req: any = {
    params: { venueId: 'venue-1', shiftId: 'shift-1' },
    body,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'Avoqado test' },
    authContext: { orgId: 'org-1', userId: 'staff-authenticated' },
  }
  return { req, res: { status } as any, next, status, json }
}

describe('shift.tpv.controller close contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    closeShiftForVenueWithResult.mockResolvedValue({
      shift: { id: 'shift-1', cashDifference: null },
      reconciliation: { outcome: 'NOT_REQUESTED' },
    })
  })

  it.each([
    ['empty body', {}],
    ['old TPV body', { venueId: 'venue-1', shiftId: 'shift-1', closeData: null }],
  ])('does not fabricate zero declarations for %s', async (_label, body) => {
    const http = makeHttp(body)

    await closeShift(http.req, http.res, http.next)

    expect(closeShiftForVenueWithResult).toHaveBeenCalledWith(
      'venue-1',
      'shift-1',
      body,
      expect.objectContaining({
        orgId: 'org-1',
        actorStaffId: 'staff-authenticated',
      }),
    )
    expect(http.next).not.toHaveBeenCalled()
  })

  it.each([
    ['Avoqado Desktop top-level declaration', { cashDeclared: 6000, notes: 'Corte desktop' }],
    ['nested legacy declaration', { closeData: { cashDeclared: 6000 } }],
    ['new zero count', { cashReconciliationAction: 'COUNTED', countedCash: '0.00' }],
    ['intentional skip', { cashReconciliationAction: 'SKIPPED' }],
  ])('forwards %s without rewriting its shape', async (_label, body) => {
    const http = makeHttp(body)

    await closeShift(http.req, http.res, http.next)

    expect(closeShiftForVenueWithResult).toHaveBeenCalledTimes(1)
    expect(closeShiftForVenueWithResult.mock.calls[0][2]).toEqual(body)
  })

  it('keeps the Shift in data and adds reconciliation at the response root', async () => {
    const reconciliation = {
      outcome: 'APPLIED',
      countedCash: '6000.00',
      cashDifference: '0.00',
    }
    closeShiftForVenueWithResult.mockResolvedValue({
      shift: { id: 'shift-1', cashDifference: '0.00' },
      reconciliation,
    })
    const http = makeHttp({ cashReconciliationAction: 'COUNTED', countedCash: '6000.00' })

    await closeShift(http.req, http.res, http.next)

    expect(http.status).toHaveBeenCalledWith(200)
    expect(http.json).toHaveBeenCalledWith({
      success: true,
      data: { id: 'shift-1', cashDifference: '0.00' },
      reconciliation,
    })
  })
})
