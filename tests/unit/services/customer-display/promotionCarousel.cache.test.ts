// tests/unit/services/customer-display/promotionCarousel.cache.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { fingerprintOf } from '@/services/customer-display/canonicalHash'
import { PollWorkLimiter } from '@/services/customer-display/pollWork'
import {
  NO_PROMOTIONS_FINGERPRINT,
  type CarouselForDevice,
  carouselForDevice,
  peekCarouselFingerprint,
  readCarouselCached,
  refreshCarousel,
  resetCarouselCacheForTests,
} from '@/services/customer-display/promotionCarousel.service'

jest.mock('@/services/customer-display/storageOrigins', () => ({
  ...jest.requireActual('@/services/customer-display/storageOrigins'),
  configuredStorageBucket: jest.fn(() => 'bucket-de-prueba.appspot.com'),
}))

beforeEach(() => {
  resetCarouselCacheForTests()
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.promotion.findMany.mockResolvedValue([] as any)
})

it('la constante sin PROMOTIONS es el literal del contrato (R9) y no se confunde con un carrusel vacío', async () => {
  expect(NO_PROMOTIONS_FINGERPRINT).toBe('0'.repeat(32))
  const vacio = await refreshCarousel('venue-a')
  expect(vacio.fingerprint).not.toBe(NO_PROMOTIONS_FINGERPRINT)
})

it('🔴 Codex r1 #7: la lectura COMPLETA vuelve a exigir «vendible» en la base — también la opción 52, que no se descarga', async () => {
  const ligera = {
    id: 'p1',
    name: 'Combo',
    displayOrder: 0,
    validFrom: null,
    validUntil: null,
    daysOfWeek: [],
    timeFrom: null,
    timeUntil: null,
  }
  const opcion = { quantity: 1, chargedQuantity: 1, priceDeltaCents: 0, product: { price: '90.00' } }
  const completa = {
    ...ligera,
    type: 'COMBO',
    pricingMode: 'FIXED_TOTAL',
    priceCents: 5000,
    imageUrl: null,
    updatedAt: new Date(),
    groups: [{ minSelect: 1, maxSelect: 1, options: Array.from({ length: 51 }, () => opcion) }], // lo que cabe en la lectura
  }
  prismaMock.promotion.findMany
    .mockResolvedValueOnce([ligera] as any) // vigentes: entre las dos lecturas, el producto de la opción 52 se desactivó…
    .mockResolvedValueOnce([] as any) // futuras
    // …y sólo una consulta que filtra «vendible» en la base lo ve: la promoción ya no regresa.
    .mockImplementationOnce((async (args: any) => (args.where?.groups?.every?.options?.every?.product ? [] : [completa])) as any)
  expect((await refreshCarousel('venue-a')).carousel).toEqual([])
})

it('lectura cacheada: una sola construcción por venue; peek la ve', async () => {
  await Promise.all([readCarouselCached('venue-a'), readCarouselCached('venue-a')])
  expect(prismaMock.venue.findUnique).toHaveBeenCalledTimes(1)
  expect(peekCarouselFingerprint('venue-a')).toMatch(/^[0-9a-f]{32}$/)
})

it('🔴 Codex r1 #2: el lugar del carrusel no se suelta con una lectura viva', async () => {
  let soltar!: (v: unknown) => void
  prismaMock.venue.findUnique.mockRejectedValueOnce(new Error('base caída')) // la primera falla YA…
  prismaMock.promotion.findMany.mockReturnValueOnce(new Promise(r => (soltar = r)) as any) // …y otra sigue en la base
  const limiter = new PollWorkLimiter(1)
  const lectura = readCarouselCached('venue-a', { limiter }).catch(e => e)
  await new Promise(r => setImmediate(r))
  expect(limiter.enVuelo).toBe(1)
  soltar([])
  expect(await lectura).toEqual(new Error('base caída'))
  expect(limiter.enVuelo).toBe(0)
})

it('refresh reconstruye y deja lo nuevo para el poll', async () => {
  await readCarouselCached('venue-a')
  await refreshCarousel('venue-a')
  expect(prismaMock.venue.findUnique).toHaveBeenCalledTimes(2)
})

describe('carouselForDevice — sólo el aparato que lo entiende (decisión 1)', () => {
  it.each([
    ['sin X-Device-Id', null, undefined],
    ['aparato sin binding POS_ANDROID', 'dev-1', null],
    ['versión 1', 'dev-1', { customerDisplayDesignVersion: 1 }],
    ['sin versión', 'dev-1', { customerDisplayDesignVersion: null }],
  ])('%s → null, sin construir', async (_caso, deviceUid, fila) => {
    if (fila !== undefined) prismaMock.terminal.findFirst.mockResolvedValueOnce(fila as any)
    expect(await carouselForDevice('venue-a', deviceUid)).toBeNull()
    expect(prismaMock.promotion.findMany).not.toHaveBeenCalled()
  })

  it('versión 2: carrusel, meta, estado ok, su zona y su propia huella', async () => {
    prismaMock.terminal.findFirst.mockResolvedValueOnce({ customerDisplayDesignVersion: 2 } as any)
    const r = await carouselForDevice('venue-a', 'dev-1')
    expect(r).toEqual({
      timezone: 'America/Mexico_City',
      carousel: [],
      carouselTruncated: false,
      carouselEvaluated: 0,
      carouselStatus: 'ok',
      fingerprints: { promotions: expect.stringMatching(/^[0-9a-f]{32}$/) },
    })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'venue-a', deviceUid: 'dev-1', type: 'POS_ANDROID' } }),
    )
  })

  it('🔴 Codex r1 #6: la zona que entrega es la MISMA con que calculó su huella', async () => {
    prismaMock.terminal.findFirst.mockResolvedValueOnce({ customerDisplayDesignVersion: 2 } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Tijuana' } as any)
    const r = (await carouselForDevice('venue-a', 'dev-1')) as Extract<CarouselForDevice, { carouselStatus: 'ok' }>
    expect(r.timezone).toBe('America/Tijuana')
    expect(r.fingerprints.promotions).toBe(fingerprintOf({ timezone: 'America/Tijuana', carousel: r.carousel }))
  })

  it('versión 2 con la base fallando: estado failed, SIN carrusel (ausente ≠ vacío)', async () => {
    prismaMock.terminal.findFirst.mockResolvedValueOnce({ customerDisplayDesignVersion: 2 } as any)
    prismaMock.promotion.findMany.mockRejectedValueOnce(new Error('base caída'))
    expect(await carouselForDevice('venue-a', 'dev-1')).toEqual({ carouselStatus: 'failed' })
  })
})
