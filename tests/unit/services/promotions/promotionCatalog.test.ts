import prisma from '@/utils/prismaClient'
import { listPromotionsForPos } from '@/services/promotions/promotionCatalog.service'

const prismaMock = prisma as any

const promo = (over: Record<string, unknown> = {}) => ({
  id: 'promo-1',
  name: 'Martes de cerveza',
  description: null,
  imageUrl: null,
  type: 'BUNDLE',
  pricingMode: 'PER_UNIT',
  priceCents: 0,
  status: 'PUBLISHED',
  displayOrder: 0,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  groups: [],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('listPromotionsForPos', () => {
  it('una promoción vigente ahora sale en activas', async () => {
    // 2026-08-12 19:00 CST = 2026-08-13 01:00 UTC.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ timeFrom: '18:00', timeUntil: '20:00' })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-13T01:00:00Z'))

    expect(result.active.map(p => p.id)).toEqual(['promo-1'])
    expect(result.upcoming).toEqual([])
  })

  it('una que empieza en 2 horas sale en próximas', async () => {
    // 15:00 CST; la promo abre a las 17:00.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ timeFrom: '17:00', timeUntil: '20:00' })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T21:00:00Z'))

    expect(result.active).toEqual([])
    expect(result.upcoming.map(p => p.id)).toEqual(['promo-1'])
    expect(result.upcoming[0].startsAt).toBe('17:00')
  })

  it('🔴 una que empieza en 6 horas NO se muestra — el horizonte son 4', async () => {
    // 12:00 CST; abre a las 22:00.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ timeFrom: '22:00', timeUntil: '23:00' })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T18:00:00Z'))

    expect(result.active).toEqual([])
    expect(result.upcoming).toEqual([])
  })

  it('las activas van ordenadas por displayOrder', async () => {
    prismaMock.promotion.findMany.mockResolvedValue([promo({ id: 'b', displayOrder: 2 }), promo({ id: 'a', displayOrder: 1 })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T18:00:00Z'))

    expect(result.active.map(p => p.id)).toEqual(['a', 'b'])
  })

  it('sólo se consultan las PUBLISHED', async () => {
    prismaMock.promotion.findMany.mockResolvedValue([])

    await listPromotionsForPos('venue-1', new Date())

    expect(prismaMock.promotion.findMany.mock.calls[0][0].where).toMatchObject({ venueId: 'venue-1', status: 'PUBLISHED' })
  })

  it('🔴 una que abre Y CIERRA dentro del horizonte también sale en próximas', async () => {
    // Audit 2026-08-13 (Codex): a las 15:00, una promo de 17:00–18:00 quedaba
    // fuera porque el único muestreo era exactamente now+4h (19:00), cuando ya
    // volvió a estar cerrada. La ventana se recorre completa, no un punto.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ timeFrom: '17:00', timeUntil: '18:00' })])

    // 15:00 CST = 21:00 UTC
    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T21:00:00Z'))

    expect(result.active).toEqual([])
    expect(result.upcoming.map(p => p.id)).toEqual(['promo-1'])
    expect(result.upcoming[0].startsAt).toBe('17:00')
  })

  it('una promo cuyo validFrom empieza dentro del horizonte sale en próximas', async () => {
    // 15:00 CST; la promo arranca por FECHA a las 17:00 CST (23:00 UTC), sin horario.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ validFrom: new Date('2026-08-12T23:00:00Z') })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T21:00:00Z'))

    expect(result.active).toEqual([])
    expect(result.upcoming.map(p => p.id)).toEqual(['promo-1'])
  })

  it('una promo cuyo validFrom empieza DESPUÉS del horizonte no sale', async () => {
    prismaMock.promotion.findMany.mockResolvedValue([promo({ validFrom: new Date('2026-08-13T04:00:00Z') })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T21:00:00Z'))

    expect(result.active).toEqual([])
    expect(result.upcoming).toEqual([])
  })

  it('el query trae también las que arrancan dentro del horizonte (validFrom ≤ now+4h)', async () => {
    prismaMock.promotion.findMany.mockResolvedValue([])
    const now = new Date('2026-08-12T21:00:00Z')

    await listPromotionsForPos('venue-1', now)

    const where = prismaMock.promotion.findMany.mock.calls[0][0].where
    const validFromOr = where.AND[0].OR
    expect(validFromOr).toEqual([{ validFrom: null }, { validFrom: { lte: new Date('2026-08-13T01:00:00Z') } }])
  })

  it('una promo aún no válida por fecha NO sale en activas aunque su horario aplique', async () => {
    // validFrom mañana; sin timeFrom/timeUntil el horario "aplica" todo el día.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ validFrom: new Date('2026-08-13T04:00:00Z') })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T18:00:00Z'))

    expect(result.active).toEqual([])
  })
})
