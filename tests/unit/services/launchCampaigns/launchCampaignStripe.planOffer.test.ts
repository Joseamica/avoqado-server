/**
 * Planes editables B1, Task 7: activar una campaña de lanzamiento con la oferta de los planes en versiones.
 *
 * 🔴 Lo que fija:
 * - el precio de lista de una campaña es el MENSUAL de la versión que cobra (la v2 o más, por su `priceId`); sin ella (sin
 *   versiones o sólo la v1), la llave del plan, exactamente como B0;
 * - el cupón queda atado a la versión con la que se calculó su descuento (`LC_<code>_V<n>_P<versión>`; el id de hoy con la v1);
 * - Stripe va ANTES del candado `plan-offer-publish` y bajo el candado sólo la base: el puntero se relee y el CAS confirma;
 * - con una publicación pendiente, un plan fuera de venta o una vista previa vieja, no se crea nada en Stripe.
 *
 * CERO llamadas reales a Stripe: el SDK entero está simulado.
 */
const mockCouponCreate = jest.fn()
const mockCouponRetrieve = jest.fn()
const mockCouponDel = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    coupons: { create: mockCouponCreate, retrieve: mockCouponRetrieve, del: mockCouponDel },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    subscriptions: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
  })),
)

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { activateLaunchCampaign, launchCouponId, readPlanListPrice } from '@/services/launchCampaigns/launchCampaignStripe.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const LISTA = 115884 // PRO mensual con IVA (la llave y la v1)
const ANUNCIADO = 2200

function ficha(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lc-1',
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
    featuredForVertical: false,
    planTier: 'PRO',
    billingInterval: 'MONTHLY',
    advertisedPriceCents: ANUNCIADO,
    discountMonths: 3,
    currency: 'MXN',
    offerVersion: 1,
    listPriceCentsSnapshot: null,
    discountAmountCents: null,
    stripePriceId: null,
    stripeCouponId: null,
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validUntil: new Date('2099-01-01T00:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 0,
    headline: null,
    subheadline: null,
    bullets: [],
    status: 'DRAFT',
    statusReason: null,
    activatedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  }
}

/** Un precio de Stripe que sirve para una campaña (mensual, MXN, IVA incluido, del producto del plan). */
const precio = (id: string, unitAmount: number, extra: Record<string, unknown> = {}) => ({
  id,
  object: 'price',
  active: true,
  product: 'prod_plan_pro',
  currency: 'mxn',
  recurring: { interval: 'month', interval_count: 1 },
  tax_behavior: 'inclusive',
  unit_amount: unitAmount,
  ...extra,
})

const brutoDe = (neto: number) => Math.round((neto * 116) / 100)

/** v2 que cambia el mensual de Pro a $1,099 + IVA; v3 a $1,199 + IVA. */
const NETO_V2 = 109900
const NETO_V3 = 119900
const LISTA_V2 = brutoDe(NETO_V2) // 127484
const LISTA_V3 = brutoDe(NETO_V3) // 139084
const versionDos = () => definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': NETO_V2 } })
const versionTres = () => definicionDePrueba({ ids: idsDeLaVersion('v3'), netos: { 'PRO:monthly': NETO_V3 } })

/** Lo que Stripe tiene: los precios de las versiones por id y los cupones creados. */
let precios: Record<string, ReturnType<typeof precio>>
let cupones: Map<string, Record<string, unknown>>
/** Lo que devuelve el puntero de la oferta en cada lectura (lo cambia la prueba para simular una publicación). */
let puntero: unknown

const sinCupon = () => Object.assign(new Error('No such coupon'), { code: 'resource_missing', statusCode: 404 })
/** Las llamadas a Stripe, en el orden global de Jest. */
const ordenDeStripe = () =>
  [mockCouponCreate, mockCouponRetrieve, mockCouponDel, mockPriceList, mockPriceRetrieve].flatMap(m => m.mock.invocationCallOrder)
/** El `$executeRaw` que toma `plan-offer-publish`. */
const tomasDelCandado = () =>
  (prismaMock.$executeRaw as jest.Mock).mock.calls
    .map((c, i) => ({ c, orden: (prismaMock.$executeRaw as jest.Mock).mock.invocationCallOrder[i] }))
    .filter(({ c }) => Array.isArray(c[0]) && c[0].join('').includes('pg_advisory_xact_lock') && c.includes('plan-offer-publish'))

beforeEach(() => {
  jest.clearAllMocks()
  precios = {
    price_key_pro_m: precio('price_key_pro_m', LISTA),
    price_v2_pro_m: precio('price_v2_pro_m', LISTA_V2),
    price_v3_pro_m: precio('price_v3_pro_m', LISTA_V3),
    price_v1_pro_m: precio('price_v1_pro_m', LISTA),
    price_v2_premium_m: precio('price_v2_premium_m', brutoDe(169900), { product: 'prod_plan_premium' }),
  }
  cupones = new Map()
  puntero = null
  mockPriceList.mockReset().mockResolvedValue({ data: [precios.price_key_pro_m] })
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (!precios[id]) throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
    return precios[id]
  })
  mockCouponRetrieve.mockReset().mockImplementation(async (id: string) => {
    const c = cupones.get(id)
    if (!c) throw sinCupon()
    return c
  })
  mockCouponCreate.mockReset().mockImplementation(async (body: Record<string, unknown>) => {
    const c = { ...body, valid: true }
    cupones.set(body.id as string, c)
    return c
  })
  prismaMock.planOfferPointer.findUnique.mockReset().mockImplementation(async () => puntero)
  prismaMock.launchCampaign.findUnique.mockReset().mockResolvedValue(ficha() as never)
  prismaMock.launchCampaign.findUniqueOrThrow.mockReset().mockResolvedValue(ficha({ status: 'ACTIVE' }) as never)
  prismaMock.launchCampaign.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
})

describe('readPlanListPrice con la oferta en versiones', () => {
  it('readPlanListPrice lee el mensual de la v2 con retrieve y no lista la llave; con sólo la v1, la llave como hoy', async () => {
    puntero = punteroA('cv2', 2, versionDos())
    await expect(readPlanListPrice('PRO', ANUNCIADO)).resolves.toMatchObject({
      id: 'price_v2_pro_m',
      unitAmount: LISTA_V2,
      productId: 'prod_plan_pro',
    })
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m')
    expect(mockPriceList).not.toHaveBeenCalled()

    jest.clearAllMocks()
    puntero = punteroA('cv1', 1, definicionDePrueba({ ids: idsDeLaVersion('v1') }))
    await expect(readPlanListPrice('PRO', ANUNCIADO)).resolves.toMatchObject({ id: 'price_key_pro_m', unitAmount: LISTA })
    expect(mockPriceList).toHaveBeenCalledWith({ lookup_keys: ['plan_pro_monthly'], limit: 1 })
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('con la v2, un precio suyo archivado o de otra forma no sirve: 409 PLAN_PRICE_UNAVAILABLE (las mismas comprobaciones más active)', async () => {
    puntero = punteroA('cv2', 2, versionDos())
    for (const malo of [{ active: false }, { tax_behavior: 'exclusive' }, { currency: 'usd' }, { recurring: { interval: 'year' } }]) {
      precios.price_v2_pro_m = precio('price_v2_pro_m', LISTA_V2, malo)
      await expect(readPlanListPrice('PRO', ANUNCIADO)).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PRICE_UNAVAILABLE' })
    }
    expect(mockPriceList).not.toHaveBeenCalled()
  })
})

describe('launchCouponId', () => {
  it('launchCouponId sin versión o con 1 es el de hoy (LC_POS22_V1); con la v2 es LC_POS22_V1_P2', () => {
    expect(launchCouponId('POS22', 1)).toBe('LC_POS22_V1')
    expect(launchCouponId('POS22', 1, 1)).toBe('LC_POS22_V1')
    expect(launchCouponId('POS22', 1, 2)).toBe('LC_POS22_V1_P2')
    expect(launchCouponId('POS22', 2, 3)).toBe('LC_POS22_V2_P3')
  })
})

describe('activateLaunchCampaign bajo el candado de la oferta', () => {
  it('🔴 con expectedListPriceCents distinto del precio de lista leído → 409 LAUNCH_CAMPAIGN_PREVIEW_STALE y cero coupons.retrieve/create', async () => {
    // La vista previa vio $1,158.84; después se publicó la v2 con otro mensual.
    puntero = punteroA('cv2', 2, versionDos())

    await expect(activateLaunchCampaign('lc-1', 'staff-1', undefined, { expectedListPriceCents: LISTA })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAUNCH_CAMPAIGN_PREVIEW_STALE',
      details: { esperado: LISTA, actual: LISTA_V2 },
    })
    expect(mockCouponRetrieve).not.toHaveBeenCalled()
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()

    // Con el precio que de verdad se lee, sí activa (y sin el dato, como el SUPERADMIN viejo, también).
    await activateLaunchCampaign('lc-1', 'staff-1', undefined, { expectedListPriceCents: LISTA_V2 })
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledTimes(1)
  })

  it('activar con una publicación pendiente → 409 PLAN_OFFER_PENDING y cero llamadas a Stripe', async () => {
    puntero = { ...punteroA('cv1', 1, definicionDePrueba({ ids: idsDeLaVersion('v1') })), pendingVersionId: 'cvpend' }

    await expect(activateLaunchCampaign('lc-1', 'staff-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_PENDING',
      details: { pendingVersionId: 'cvpend' },
    })
    expect(ordenDeStripe()).toEqual([])
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('activar una campaña de Premium con Premium fuera de venta → 409 PLAN_NOT_ON_SALE', async () => {
    const d = definicionDePrueba({ ids: idsDeLaVersion('v2') })
    d.PREMIUM.onSale = false
    puntero = punteroA('cv2', 2, d)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ planTier: 'PREMIUM' }) as never)

    await expect(activateLaunchCampaign('lc-1', 'staff-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_NOT_ON_SALE',
      details: { planTier: 'PREMIUM' },
    })
    expect(ordenDeStripe()).toEqual([])
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 ninguna llamada a Stripe ocurre después de tomar plan-offer-publish', async () => {
    puntero = punteroA('cv2', 2, versionDos())

    await activateLaunchCampaign('lc-1', 'staff-1')

    const [toma] = tomasDelCandado()
    expect(toma).toBeDefined()
    // El candado va DESPUÉS de crear el cupón y ANTES del CAS…
    expect(mockCouponCreate).toHaveBeenCalledTimes(1)
    expect(mockCouponCreate.mock.invocationCallOrder[0]).toBeLessThan(toma.orden)
    expect(toma.orden).toBeLessThan(prismaMock.launchCampaign.updateMany.mock.invocationCallOrder[0])
    // …y ninguna llamada a Stripe ocurre con él tomado.
    expect(ordenDeStripe().filter(o => o > toma.orden)).toEqual([])
    // Bajo el candado se relee el puntero (después de tomarlo).
    const lecturas = prismaMock.planOfferPointer.findUnique.mock.invocationCallOrder
    expect(lecturas.some(o => o > toma.orden && o < prismaMock.launchCampaign.updateMany.mock.invocationCallOrder[0])).toBe(true)
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ACTIVE',
          stripeCouponId: 'LC_POS22_V1_P2',
          listPriceCentsSnapshot: LISTA_V2,
          discountAmountCents: LISTA_V2 - ANUNCIADO,
        }),
      }),
    )
  })

  it('🔴 si entre el cupón y el candado se publicó la v3 → 409 PLAN_OFFER_STALE; el reintento usa LC_POS22_V1_P3 con el descuento del mensual nuevo, sin COUPON_CONFLICT', async () => {
    puntero = punteroA('cv2', 2, versionDos())
    // La v3 se publica justo cuando Stripe termina de crear el cupón de la v2 (antes del candado de la activación).
    mockCouponCreate.mockImplementationOnce(async (body: Record<string, unknown>) => {
      cupones.set(body.id as string, { ...body, valid: true })
      puntero = punteroA('cv3', 3, versionTres())
      return body
    })

    await expect(activateLaunchCampaign('lc-1', 'staff-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_STALE',
      details: { leida: 2, vigente: 3 },
    })
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
    // El cupón de la v2 queda sin usar: nadie lo guarda.
    expect(mockCouponCreate.mock.calls[0][0]).toMatchObject({ id: 'LC_POS22_V1_P2', amount_off: LISTA_V2 - ANUNCIADO })

    // El reintento calcula con el mensual de la v3 y crea OTRO cupón; nunca choca con el de la v2.
    await activateLaunchCampaign('lc-1', 'staff-1')

    expect(mockCouponCreate).toHaveBeenCalledTimes(2)
    expect(mockCouponCreate.mock.calls[1][0]).toMatchObject({ id: 'LC_POS22_V1_P3', amount_off: LISTA_V3 - ANUNCIADO })
    expect(mockCouponCreate.mock.calls[1][1]).toEqual({ idempotencyKey: 'lc-coupon:LC_POS22_V1_P3' })
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.launchCampaign.updateMany.mock.calls[0][0].data).toMatchObject({
      stripeCouponId: 'LC_POS22_V1_P3',
      listPriceCentsSnapshot: LISTA_V3,
      discountAmountCents: LISTA_V3 - ANUNCIADO,
    })
  })

  it('🔴 si la v2 se publica entre el paso 1 y la lectura del precio de lista → 409 PLAN_OFFER_STALE y cero cupones', async () => {
    // El paso 1 lee el puntero dos veces (la pendiente y la vigente) y ve la v1; la lectura del precio de lista ya ve la v2.
    const v1 = punteroA('cv1', 1, definicionDePrueba({ ids: idsDeLaVersion('v1') }))
    const v2 = punteroA('cv2', 2, versionDos())
    let lecturas = 0
    prismaMock.planOfferPointer.findUnique.mockImplementation((async () => (++lecturas <= 2 ? v1 : v2)) as never)

    await expect(activateLaunchCampaign('lc-1', 'staff-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_STALE',
      details: { leida: 1, vigente: 2 },
    })
    // El precio de la v2 sí se leyó, pero ningún cupón se buscó ni se creó con él: sería un `_P2` con otra versión leída.
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m')
    expect(mockCouponRetrieve).not.toHaveBeenCalled()
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(mockCouponDel).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('el mensual de la v2 existe en Stripe con OTRO importe que el de la versión → 409 PLAN_PRICE_UNAVAILABLE y cero cupones', async () => {
    puntero = punteroA('cv2', 2, versionDos())
    precios.price_v2_pro_m = precio('price_v2_pro_m', LISTA_V2 + 100)

    await expect(activateLaunchCampaign('lc-1', 'staff-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PRICE_UNAVAILABLE',
      details: { versionDeLaOferta: 2, priceId: 'price_v2_pro_m', motivo: 'su importe no es el de la versión vigente' },
    })
    expect(mockCouponRetrieve).not.toHaveBeenCalled()
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(mockCouponDel).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 reactivar después de publicar una v2 que sólo cambió el anual: comprueba y conserva LC_POS22_V1 (no guarda LC_POS22_V1_P2)', async () => {
    // La v2 hereda el mensual de la v1 (su mismo priceId) y sólo trae un anual nuevo.
    const d = definicionDePrueba({
      ids: { ...idsDeLaVersion('v2'), 'PRO:monthly': 'price_v1_pro_m' },
      netos: { 'PRO:annual': 1099000 },
    })
    puntero = punteroA('cv2', 2, d)
    cupones.set('LC_POS22_V1', { id: 'LC_POS22_V1', valid: true, amount_off: LISTA - ANUNCIADO })
    prismaMock.launchCampaign.findUnique.mockResolvedValue(
      ficha({
        status: 'PAUSED',
        stripeCouponId: 'LC_POS22_V1',
        listPriceCentsSnapshot: LISTA,
        discountAmountCents: LISTA - ANUNCIADO,
        activatedAt: new Date('2026-09-02T00:00:00Z'),
      }) as never,
    )

    await activateLaunchCampaign('lc-1', 'staff-1')

    expect(mockCouponRetrieve.mock.calls.map(c => c[0])).toEqual(['LC_POS22_V1'])
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'ACTIVE',
      stripeCouponId: 'LC_POS22_V1',
      listPriceCentsSnapshot: LISTA,
    })
  })

  it('sin versiones (o sólo la v1) activa exactamente como hoy: la llave, LC_POS22_V1 y su llave de idempotencia', async () => {
    for (const p of [null, punteroA('cv1', 1, definicionDePrueba({ ids: idsDeLaVersion('v1') }))]) {
      jest.clearAllMocks()
      cupones.clear()
      puntero = p
      await activateLaunchCampaign('lc-1', 'staff-1')
      expect(mockPriceList).toHaveBeenCalledWith({ lookup_keys: ['plan_pro_monthly'], limit: 1 })
      expect(mockPriceRetrieve).not.toHaveBeenCalled()
      expect(mockCouponCreate.mock.calls[0][0]).toMatchObject({ id: 'LC_POS22_V1', amount_off: LISTA - ANUNCIADO })
      expect(mockCouponCreate.mock.calls[0][1]).toEqual({ idempotencyKey: 'lc-coupon:LC_POS22_V1' })
      expect(prismaMock.launchCampaign.updateMany.mock.calls[0][0].data).toMatchObject({ stripeCouponId: 'LC_POS22_V1' })
    }
  })
})
