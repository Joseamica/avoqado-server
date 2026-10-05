import { prismaMock } from '@tests/__helpers__/setup'

const mockMarkNoShow = jest.fn()
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  PASS_ARRIVAL_PENDING: 'PASS_ARRIVAL_PENDING',
  markNoShow: (...a: unknown[]) => mockMarkNoShow(...a),
}))

import { reservationAutoNoShowJob } from '@/jobs/reservation-auto-no-show.job'

const candidata = (id: string) => ({
  id,
  venueId: 'v1',
  confirmationCode: `RES-${id}`,
  startsAt: new Date(Date.now() - 60 * 60_000),
  depositStatus: null,
  depositAmount: null,
  venue: { id: 'v1', reservationSettings: { noShowGraceMin: 10, noShowFeePercent: null } },
})

describe('reservation-auto-no-show — llegadas de pase por confirmar', () => {
  beforeEach(() => mockMarkNoShow.mockReset())

  it('no toma como candidata una reserva con una visita de pase pendiente y vigente', async () => {
    prismaMock.reservation.findMany.mockResolvedValueOnce([])

    await reservationAutoNoShowJob.runNow()

    const where = (prismaMock.reservation.findMany.mock.calls[0][0] as any).where
    expect(where.aggregatorVisits).toEqual({ none: { status: 'PENDING', deadlineAt: { gt: expect.any(Date) } } })
  })

  it('si la visita entró en medio (la transición la rechaza), la salta y sigue con las demás', async () => {
    prismaMock.reservation.findMany.mockResolvedValueOnce([candidata('r1'), candidata('r2')] as any)
    mockMarkNoShow
      .mockRejectedValueOnce(Object.assign(new Error('llegada por confirmar'), { code: 'PASS_ARRIVAL_PENDING' }))
      .mockResolvedValueOnce({ id: 'r2' })

    await reservationAutoNoShowJob.runNow()

    expect(mockMarkNoShow).toHaveBeenCalledTimes(2)
    expect(mockMarkNoShow).toHaveBeenLastCalledWith('v1', 'r2', 'SYSTEM')
  })
})
