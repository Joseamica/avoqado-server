import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

const mockMarkNoShow = jest.fn()
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  PASS_ARRIVAL_PENDING: 'PASS_ARRIVAL_PENDING',
  markNoShow: (...a: unknown[]) => mockMarkNoShow(...a),
}))

const mockFlush = jest.fn()
const mockSummaries = jest.fn()
jest.mock('@/services/reservation/noShowNotices.service', () => ({
  flushPendingCorrectionNotices: (...a: unknown[]) => mockFlush(...a),
  sendClassNoShowSummaries: (...a: unknown[]) => mockSummaries(...a),
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

describe('reservation-auto-no-show — la multa sólo se anota si la reserva SIGUE en NO_SHOW (D4, Task 0)', () => {
  beforeEach(() => mockMarkNoShow.mockReset())

  const conDeposito = (id: string) => ({
    ...candidata(id),
    depositStatus: 'PAID',
    depositAmount: new Prisma.Decimal(200),
    venue: { id: 'v1', reservationSettings: { noShowGraceMin: 10, noShowFeePercent: 50 } },
  })

  it('anota la multa con una escritura condicionada a NO_SHOW', async () => {
    prismaMock.reservation.findMany.mockResolvedValueOnce([conDeposito('r1')] as any)
    mockMarkNoShow.mockResolvedValueOnce({ id: 'r1' })
    prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 1 } as any)

    await reservationAutoNoShowJob.runNow()

    expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', venueId: 'v1', status: 'NO_SHOW' },
      data: { noShowFeeAmount: 100 },
    })
    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
  })

  it('si la reserva ya se corrigió a CHECKED_IN entre el no-show y la multa, no escribe nada', async () => {
    prismaMock.reservation.findMany.mockResolvedValueOnce([conDeposito('r1')] as any)
    mockMarkNoShow.mockResolvedValueOnce({ id: 'r1' })
    prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 0 } as any)

    await reservationAutoNoShowJob.runNow()

    expect(prismaMock.reservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'NO_SHOW' }) }),
    )
    expect(prismaMock.reservation.update).not.toHaveBeenCalled()
  })
})

describe('reservation-auto-no-show — avisos de «No asistió» en cada tick (D4, Task 4)', () => {
  beforeEach(() => {
    mockMarkNoShow.mockReset()
    mockFlush.mockReset().mockResolvedValue(0)
    mockSummaries.mockReset().mockResolvedValue(0)
  })

  it('después de marcar, manda los avisos pendientes y luego los resúmenes por clase', async () => {
    prismaMock.reservation.findMany.mockResolvedValueOnce([candidata('r1')] as any)
    mockMarkNoShow.mockResolvedValueOnce({ id: 'r1' })

    await reservationAutoNoShowJob.runNow()

    expect(mockFlush).toHaveBeenCalledWith(expect.any(Date))
    expect(mockSummaries).toHaveBeenCalledWith(expect.any(Date))
    expect(mockMarkNoShow.mock.invocationCallOrder[0]).toBeLessThan(mockFlush.mock.invocationCallOrder[0])
    expect(mockFlush.mock.invocationCallOrder[0]).toBeLessThan(mockSummaries.mock.invocationCallOrder[0])
  })

  it('si el barrido de avisos truena, igual salen los resúmenes (y viceversa no tumba el tick)', async () => {
    prismaMock.reservation.findMany.mockResolvedValueOnce([] as any)
    mockFlush.mockRejectedValueOnce(new Error('resend caído'))
    mockSummaries.mockRejectedValueOnce(new Error('P1001'))

    await expect(reservationAutoNoShowJob.runNow()).resolves.toBeUndefined()
    expect(mockSummaries).toHaveBeenCalled()
  })

  it('un tick que se encima mientras el anterior sigue mandando avisos: marca igual, pero NO vuelve a mandar avisos', async () => {
    let soltar!: () => void
    const pendiente = new Promise<number>(r => (soltar = () => r(0)))
    const llegoAlBarrido = new Promise<void>(r => mockFlush.mockImplementationOnce(() => (r(), pendiente)))

    prismaMock.reservation.findMany.mockResolvedValueOnce([candidata('r1')] as any)
    mockMarkNoShow.mockResolvedValue({ id: 'x' })
    const primero = reservationAutoNoShowJob.runNow()
    await llegoAlBarrido

    prismaMock.reservation.findMany.mockResolvedValueOnce([candidata('r2')] as any)
    await reservationAutoNoShowJob.runNow()

    expect(mockMarkNoShow).toHaveBeenLastCalledWith('v1', 'r2', 'SYSTEM')
    expect(mockFlush).toHaveBeenCalledTimes(1)
    expect(mockSummaries).not.toHaveBeenCalled()

    soltar()
    await primero
    expect(mockSummaries).toHaveBeenCalledTimes(1)

    // Ya terminó: el siguiente tick vuelve a mandar avisos.
    prismaMock.reservation.findMany.mockResolvedValueOnce([] as any)
    await reservationAutoNoShowJob.runNow()
    expect(mockFlush).toHaveBeenCalledTimes(2)
  })

  it('si leer candidatas truena, los avisos igual corren', async () => {
    prismaMock.reservation.findMany.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P2010' }))

    await reservationAutoNoShowJob.runNow()

    expect(mockFlush).toHaveBeenCalled()
    expect(mockSummaries).toHaveBeenCalled()
    prismaMock.reservation.findMany.mockReset()
  })
})
