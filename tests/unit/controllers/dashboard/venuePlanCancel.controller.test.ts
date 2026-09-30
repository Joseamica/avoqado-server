jest.mock('@/services/dashboard/planState.service', () => ({ cancelPlan: jest.fn() }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({ scheduleDowngradeToFree: jest.fn() }))

import type { Request, Response } from 'express'
import { cancelPlan } from '@/services/dashboard/planState.service'
import { scheduleDowngradeToFree } from '@/services/dashboard/seatReconciliation.service'
import { cancelVenuePlan, downgradeVenueToFree } from '@/controllers/dashboard/venue.dashboard.controller'

function makeRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}
const makeReq = (body: unknown) =>
  ({ params: { venueId: 'venue_1' }, body, authContext: { userId: 'staff_1', venueId: 'venue_1' } }) as unknown as Request<{
    venueId: string
  }>

beforeEach(() => {
  jest.clearAllMocks()
  ;(cancelPlan as jest.Mock).mockResolvedValue({ state: 'canceling' })
  ;(scheduleDowngradeToFree as jest.Mock).mockResolvedValue({ state: 'canceling' })
})

describe('plan cancel controllers pass the reason and the actor', () => {
  it('cancel with a reason', async () => {
    const res = makeRes()
    await cancelVenuePlan(makeReq({ reason: 'TOO_COMPLEX', comment: 'Difícil' }), res, jest.fn())
    expect(cancelPlan).toHaveBeenCalledWith('venue_1', { reason: 'TOO_COMPLEX', comment: 'Difícil', staffId: 'staff_1' })
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('cancel with the empty body an old dashboard sends', async () => {
    await cancelVenuePlan(makeReq({}), makeRes(), jest.fn())
    expect(cancelPlan).toHaveBeenCalledWith('venue_1', { reason: undefined, comment: undefined, staffId: 'staff_1' })
  })

  it('downgrade keeps the selection and adds the reason', async () => {
    await downgradeVenueToFree(makeReq({ keepStaffVenueIds: ['sv1', 'sv2'], reason: 'SWITCHED_SERVICE' }) as never, makeRes(), jest.fn())
    expect(scheduleDowngradeToFree).toHaveBeenCalledWith('venue_1', ['sv1', 'sv2'], {
      reason: 'SWITCHED_SERVICE',
      comment: undefined,
      staffId: 'staff_1',
    })
  })
})
