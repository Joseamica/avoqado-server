/**
 * El candado «primer-sobre» (spec 2026-10-30-saldo-a-favor §5.5, tarea S2): cierra la carrera entre la «devolución sin venta» y el
 * primer sobre de la sucursal. Siempre es el PRIMER candado de su transacción. El cruce real en Postgres lo prueba S6.
 */
import { tomarCandadoPrimerSobreEnTx, tomarCandadoPrimerSobreSiHaceFaltaEnTx } from '@/services/storeCredit/primerSobreLock'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const textoDe = (arg: any): string => (Array.isArray(arg) ? arg.join('?') : '')

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$queryRaw.mockReset().mockResolvedValue([{ pg_advisory_xact_lock: '' }] as any)
  prismaMock.giftCard.findFirst.mockReset()
})

describe('tomarCandadoPrimerSobreEnTx', () => {
  it('toma pg_advisory_xact_lock con la llave primer-sobre:<venueId>', async () => {
    await tomarCandadoPrimerSobreEnTx(prismaMock, VENUE)
    const [plantilla, ...valores] = prismaMock.$queryRaw.mock.calls[0] as any[]
    expect(textoDe(plantilla)).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\)\)/)
    expect(valores).toEqual(['primer-sobre:venue-1'])
  })
})

describe('tomarCandadoPrimerSobreSiHaceFaltaEnTx', () => {
  it('con un sobre activado no toma el candado', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue({ id: 'gc-1' } as any)
    await tomarCandadoPrimerSobreSiHaceFaltaEnTx(prismaMock, VENUE)
    expect(prismaMock.giftCard.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE, activatedAt: { not: null } },
      select: { id: true },
    })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('sin sobres lo toma', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(null)
    await tomarCandadoPrimerSobreSiHaceFaltaEnTx(prismaMock, VENUE)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect((prismaMock.$queryRaw.mock.calls[0] as any[]).slice(1)).toEqual(['primer-sobre:venue-1'])
  })
})
