import { prismaMock } from '@tests/__helpers__/setup'
import { getMyClassNow, spotLabel } from '@/services/reservation/coachClass.service'

describe('getMyClassNow — socios de pase', () => {
  it('cada asistente dice si viene por un pase y de qué proveedor; el propio va en null', async () => {
    prismaMock.classSession.findFirst.mockResolvedValueOnce({
      id: 's1',
      startsAt: new Date('2026-10-04T15:00:00Z'),
      endsAt: new Date('2026-10-04T16:00:00Z'),
      capacity: 10,
      product: { name: 'Barre', layoutConfig: null },
      reservations: [
        {
          id: 'r1',
          status: 'CONFIRMED',
          spotIds: [],
          customer: { firstName: 'Ana', lastName: 'Gómez' },
          guestName: null,
          aggregatorBooking: { provider: 'TOTALPASS' },
        },
        { id: 'r2', status: 'CHECKED_IN', spotIds: [], customer: null, guestName: 'Luis Pérez', aggregatorBooking: null },
      ],
    } as any)

    const out = await getMyClassNow({ venueId: 'v1', staffId: 'st1', now: new Date('2026-10-04T15:00:00Z') })

    expect(out?.attendees.map(a => a.passProvider)).toEqual(['TOTALPASS', null])
    const select = (prismaMock.classSession.findFirst.mock.calls[0][0] as any).select
    expect(select.reservations.select.aggregatorBooking).toEqual({ select: { provider: true } })
  })
})

// Regresión del mapa «dado»: el panel guarda las casillas apagadas con `label: ''`; el nombre del lugar sale de la
// casilla reservada (siempre prendida) y una apagada sin etiqueta nunca se pinta como lugar vacío.
describe('spotLabel — mapa con casillas apagadas sin etiqueta', () => {
  const dado = {
    spots: [
      { id: '0-0', label: '1', enabled: true },
      { id: '0-1', label: '', enabled: false },
      { id: '1-1', label: '3', enabled: true },
    ],
  }

  it('nombra el lugar prendido que se reservó', () => {
    expect(spotLabel(['1-1'], dado)).toBe('3')
  })

  it('una casilla apagada sin etiqueta no aporta un nombre vacío', () => {
    expect(spotLabel(['0-1'], dado)).toBeNull()
    expect(spotLabel(['0-0', '0-1'], dado)).toBe('1')
  })
})
