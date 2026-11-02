jest.mock('@/services/tpv/shift.tpv.service', () => ({ closeShiftForVenueWithResult: jest.fn(), getShiftOperationForVenue: jest.fn() }))
import * as service from '@/services/tpv/shift.tpv.service'
import * as controller from '@/controllers/tpv/shift.tpv.controller'

const OP = 'cm00000000000000000000001'
function http(delta: object = {}) {
  const json = jest.fn(),
    status = jest.fn().mockReturnValue({ json }),
    next = jest.fn()
  const req: any = {
    body: {
      operationId: OP,
      closedAtLocal: '2026-10-28T00:00:00-06:00',
      isOfflineReplay: true,
      cashReconciliationAction: 'COUNTED',
      countedCash: '100.00',
      staffId: 'declared-only',
      terminalSerial: 'untrusted',
    },
    params: { venueId: 'venue', shiftId: 'shift', operationId: OP },
    authContext: { userId: 'real-actor', terminalSerialNumber: 'AVQD-real', orgId: 'org' },
    headers: {},
    ...delta,
  }
  return { req, res: { status } as any, next, status, json }
}
beforeEach(() => {
  ;(service.closeShiftForVenueWithResult as jest.Mock).mockResolvedValue({
    shift: { id: 'shift' },
    reconciliation: { outcome: 'APPLIED' },
    operation: { operationId: OP, state: 'APPLIED' },
  })
  ;(service.getShiftOperationForVenue as jest.Mock).mockResolvedValue({ operation: { operationId: OP, state: 'PENDING' } })
})
describe('new operation close HTTP boundary', () => {
  it('uses authenticated actor/serial, retains original time, and adds operation beside existing data/reconciliation', async () => {
    const h = http()
    await controller.closeShift(h.req, h.res, h.next)
    expect(h.next).not.toHaveBeenCalled()
    expect(service.closeShiftForVenueWithResult).toHaveBeenCalledWith(
      'venue',
      'shift',
      h.req.body,
      expect.objectContaining({
        actorStaffId: 'real-actor',
        operation: expect.objectContaining({
          operationId: OP,
          terminalSerial: 'AVQD-real',
          declaredStaffId: 'declared-only',
          closedAtLocal: h.req.body.closedAtLocal,
        }),
      }),
    )
    expect(h.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { id: 'shift' },
        reconciliation: { outcome: 'APPLIED' },
        operation: { operationId: OP, state: 'APPLIED' },
      }),
    )
  })
  it.each([
    { operationId: 'bad' },
    { closedAtLocal: 'yesterday' },
    { isOfflineReplay: 'yes' },
    { cashDrawerSessionId: 'bad' },
    { operationId: undefined, isOfflineReplay: true },
  ])('validates metadata %j before service', async delta => {
    const h = http()
    h.req.body = { ...h.req.body, ...delta }
    await controller.closeShift(h.req, h.res, h.next)
    expect(h.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    expect(service.closeShiftForVenueWithResult).not.toHaveBeenCalled()
  })
  it('requires authenticated person and terminal', async () => {
    const h = http({ authContext: { userId: 'actor' } })
    await controller.closeShift(h.req, h.res, h.next)
    expect(h.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
  })
  it('GET is exact and serial-bound; no request payload or current-shift fallback', async () => {
    const h = http()
    await (controller as any).getShiftOperation(h.req, h.res, h.next)
    expect(service.getShiftOperationForVenue).toHaveBeenCalledWith('venue', OP, 'AVQD-real', 'real-actor')
    expect(h.json).toHaveBeenCalledWith({ success: true, operation: { operationId: OP, state: 'PENDING' } })
  })
  it('GET missing serial cannot become an unrestricted lookup', async () => {
    const h = http({ authContext: { userId: 'actor' } })
    await (controller as any).getShiftOperation(h.req, h.res, h.next)
    expect(h.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
    expect(service.getShiftOperationForVenue).not.toHaveBeenCalled()
  })
})
