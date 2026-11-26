const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ prices: { list: mockPriceList, retrieve: mockPriceRetrieve } })))

import { exigirPrecioDeStripe, resolverPrecioDelPlan, resolverPrecioPorLlave } from '../../../../src/services/billing/precioDelPlan'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

beforeEach(() => {
  mockPriceList.mockReset()
  mockPriceRetrieve.mockReset()
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
})

/** La v2 del editor: Pro mensual a $799 + IVA (92684 con IVA), con sus propios precios de Stripe. */
const VERSION_DOS = () => definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 } })

describe('sin versiones (el camino de B0, por la llave)', () => {
  it('devuelve id y monto del precio de la llave', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_A', unit_amount: 115884 }] })
    await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly')).resolves.toEqual({ priceId: 'price_A', unitAmount: 115884 })
    expect(mockPriceList).toHaveBeenCalledTimes(1)
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_monthly'], limit: 1 }), expect.anything())
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  // Codex B0 #4: las pruebas del checkout ya reciben un priceId fijo, así que aquí se fija la llave de CADA plan y ciclo.
  // Una llave anual o de Premium equivocada cobraría otro plan sin que nada más lo notara.
  it.each([
    ['PLAN_PRO', 'monthly', 'plan_pro_monthly'],
    ['PLAN_PRO', 'annual', 'plan_pro_annual'],
    ['PLAN_PREMIUM', 'monthly', 'plan_premium_monthly'],
    ['PLAN_PREMIUM', 'annual', 'plan_premium_annual'],
  ] as const)('%s %s consulta la llave %s', async (tierCode, interval, llave) => {
    mockPriceList.mockResolvedValue({ data: [{ id: `price_${llave}`, unit_amount: 100 }] })
    await expect(resolverPrecioDelPlan(tierCode, interval)).resolves.toEqual({ priceId: `price_${llave}`, unitAmount: 100 })
    expect(mockPriceList).toHaveBeenCalledTimes(1)
    expect(mockPriceList.mock.calls[0][0]).toEqual({ lookup_keys: [llave], limit: 1 })
  })

  it('sin precio lanza PLAN_NOT_CONFIGURED', async () => {
    mockPriceList.mockResolvedValue({ data: [] })
    await expect(resolverPrecioDelPlan('PLAN_PREMIUM', 'annual')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
  })

  it('resolverPrecioPorLlave es el cuerpo de B0 y no lee la oferta', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, VERSION_DOS()) as never)
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_llave', unit_amount: 115884 }] })
    await expect(resolverPrecioPorLlave('PLAN_PRO', 'monthly')).resolves.toEqual({ priceId: 'price_llave', unitAmount: 115884 })
    expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })
})

describe('con versiones', () => {
  it('🔴 con sólo la v1 resuelve por la llave como B0, aunque la llave ya apunte a price_llave_b y la foto price_v1_pro_m esté archivada', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_llave_b', unit_amount: 115884 }] })
    // Si alguien leyera la foto, la encontraría archivada.
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v1_pro_m', active: false, unit_amount: 115884 })

    await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly')).resolves.toEqual({ priceId: 'price_llave_b', unitAmount: 115884 })
    expect(mockPriceList.mock.calls[0][0]).toEqual({ lookup_keys: ['plan_pro_monthly'], limit: 1 })
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('con la v2 vigente usa su priceId con prices.retrieve y no lista la llave', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, VERSION_DOS()) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: 92684 })

    expect(await resolverPrecioDelPlan('PLAN_PRO', 'monthly')).toEqual({ priceId: 'price_v2_pro_m', unitAmount: 92684 })
    expect(mockPriceList).not.toHaveBeenCalled()
    // 🔴 Bajo el candado de la regla común: tiempo propio y sin reintentos del SDK, como la llave de B0.
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m', { timeout: 15_000, maxNetworkRetries: 0 })
  })

  it('con la v2 vigente, cada plan y ciclo lee su propia ranura', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, VERSION_DOS()) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_premium_a', active: true, unit_amount: 1970840 })
    expect(await resolverPrecioDelPlan('PLAN_PREMIUM', 'annual')).toEqual({ priceId: 'price_v2_premium_a', unitAmount: 1970840 })
    expect(mockPriceRetrieve.mock.calls[0][0]).toBe('price_v2_premium_a')
  })

  it.each([
    ['inactivo', () => mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: false, unit_amount: 92684 })],
    ['otro monto', () => mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: 115884 })],
    [
      '404',
      () =>
        mockPriceRetrieve.mockRejectedValue(
          Object.assign(new Error('No such price'), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' }),
        ),
    ],
  ])('precio de la v2 %s → 503 PLAN_NOT_CONFIGURED', async (_caso, preparar) => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, VERSION_DOS()) as never)
    preparar()
    await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('un error de Stripe que no afirma «no existe» (tiempo agotado) sube tal cual, como el de la llave en B0', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, VERSION_DOS()) as never)
    const caida = Object.assign(new Error('timeout'), { type: 'StripeConnectionError' })
    mockPriceRetrieve.mockRejectedValue(caida)
    await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly')).rejects.toBe(caida)
  })

  it('🔴 Codex b2-code #1: con { soloSinVersionDelEditor } (los carriles que cobran sin versión del editor), una v2 que aparece en la relectura → 409 OFFER_CHANGED reason VERSION con su número, sin leer ningún precio de Stripe', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, VERSION_DOS()) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: 92684 })

    await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly', { soloSinVersionDelEditor: true })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'VERSION', offerVersion: 2 },
    })
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('🔴 con { soloSinVersionDelEditor }, sin versiones o con sólo la v1, resuelve por la llave exactamente como B0', async () => {
    for (const puntero of [null, punteroA('cv1', 1, versionUno())]) {
      mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_llave', unit_amount: 115884 }] })
      prismaMock.planOfferPointer.findUnique.mockResolvedValue(puntero as never)

      await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly', { soloSinVersionDelEditor: true })).resolves.toEqual({
        priceId: 'price_llave',
        unitAmount: 115884,
      })
      expect(mockPriceList.mock.calls).toEqual([
        [
          { lookup_keys: ['plan_pro_monthly'], limit: 1 },
          { timeout: 15_000, maxNetworkRetries: 0 },
        ],
      ])
    }
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('una versión guardada rota es 503 PLAN_NOT_CONFIGURED y no cae a la llave', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, { schemaVersion: 1 }) as never)
    await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })
})

describe('exigirPrecioDeStripe', () => {
  it('exigirPrecioDeStripe: activo y del monto → { priceId, unitAmount }; inactivo, otro monto o 404 → 503 PLAN_NOT_CONFIGURED; un 500 sube tal cual', async () => {
    mockPriceRetrieve.mockResolvedValue({ id: 'price_x', active: true, unit_amount: 92684 })
    await expect(exigirPrecioDeStripe('price_x', 92684)).resolves.toEqual({ priceId: 'price_x', unitAmount: 92684 })
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_x', { timeout: 15_000, maxNetworkRetries: 0 })

    mockPriceRetrieve.mockResolvedValue({ id: 'price_x', active: false, unit_amount: 92684 })
    await expect(exigirPrecioDeStripe('price_x', 92684, { tier: 'PRO' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_NOT_CONFIGURED',
    })
    mockPriceRetrieve.mockResolvedValue({ id: 'price_x', active: true, unit_amount: 1 })
    await expect(exigirPrecioDeStripe('price_x', 92684)).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    mockPriceRetrieve.mockRejectedValue(
      Object.assign(new Error('No such price'), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' }),
    )
    await expect(exigirPrecioDeStripe('price_x', 92684)).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    const caida = Object.assign(new Error('boom'), { type: 'StripeAPIError', statusCode: 500 })
    mockPriceRetrieve.mockRejectedValue(caida)
    await expect(exigirPrecioDeStripe('price_x', 92684)).rejects.toBe(caida)
  })
})
