import { prismaMock } from '@tests/__helpers__/setup'
import { getMyClassNow } from '@/services/reservation/coachClass.service'

describe('getMyClassNow — socios de pase', () => {
  it('cada asistente dice si viene por un pase y de qué proveedor; el propio va en null', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      startsAt: new Date('2026-10-04T15:00:00Z'),
      endsAt: new Date('2026-10-04T16:00:00Z'),
      capacity: 10,
      product: { name: 'Barre', layoutConfig: null },
      reservations: [
        { id: 'r1', status: 'CONFIRMED', spotIds: [], customer: { firstName: 'Ana', lastName: 'Gómez' }, guestName: null, aggregatorBooking: { provider: 'TOTALPASS' } },
        { id: 'r2', status: 'CHECKED_IN', spotIds: [], customer: null, guestName: 'Luis Pérez', aggregatorBooking: null },
      ],
    } as any)

    const out = await getMyClassNow({ venueId: 'v1', staffId: 'st1', now: new Date('2026-10-04T15:00:00Z') })

    expect(out?.attendees.map(a => a.passProvider)).toEqual(['TOTALPASS', null])
    const select = (prismaMock.classSession.findFirst.mock.calls[0][0] as any).select
    expect(select.reservations.select.aggregatorBooking).toEqual({ select: { provider: true } })
  })
})
