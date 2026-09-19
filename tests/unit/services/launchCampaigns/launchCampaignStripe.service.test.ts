/**
 * S4 — activar una ficha crea (o reutiliza) el cupón de Stripe (spec 2026-09-17 § 3.4).
 *
 * 🔴 CERO llamadas reales a Stripe: el SDK entero está mockeado (§7.5).
 */
const mockCouponCreate = jest.fn()
const mockCouponRetrieve = jest.fn()
const mockCouponDel = jest.fn()
const mockPriceList = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    coupons: { create: mockCouponCreate, retrieve: mockCouponRetrieve, del: mockCouponDel },
    prices: { list: mockPriceList },
    subscriptions: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
  })),
)

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { activateLaunchCampaign, launchCouponId, previewLaunchOffer } from '@/services/launchCampaigns/launchCampaignStripe.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

const LISTA = 115884 // PRO mensual con IVA
const ANUNCIADO = 2200 // $22.00
const AMOUNT_OFF = 113684

function ficha(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lc-1',
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
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

const precioBueno = { id: 'price_pro_m', product: 'prod_plan_pro', currency: 'mxn', recurring: { interval: 'month' }, tax_behavior: 'inclusive', unit_amount: LISTA }

beforeEach(() => {
  jest.clearAllMocks()
  mockPriceList.mockResolvedValue({ data: [precioBueno] })
  prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
})

describe('activateLaunchCampaign', () => {
  it('crea LC_POS22_V1 con amount_off 113684, repeating 3 meses y llave de idempotencia', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockResolvedValue(ficha({ status: 'ACTIVE' }) as never)
    mockCouponRetrieve.mockRejectedValue(Object.assign(new Error('No such coupon'), { code: 'resource_missing' }))

    await activateLaunchCampaign('lc-1', 'staff-1', 'lanzamiento')

    expect(mockCouponCreate).toHaveBeenCalledTimes(1)
    const [body, options] = mockCouponCreate.mock.calls[0]
    expect(body).toMatchObject({
      id: 'LC_POS22_V1',
      amount_off: AMOUNT_OFF,
      currency: 'mxn',
      duration: 'repeating',
      duration_in_months: 3,
    })
    expect(options).toEqual({ idempotencyKey: 'lc-coupon:LC_POS22_V1' })
    // El snapshot se congela con el precio que Stripe acaba de decir, no con una constante.
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACTIVE', listPriceCentsSnapshot: LISTA, discountAmountCents: AMOUNT_OFF }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAUNCH_CAMPAIGN_ACTIVATED' }))
  })

  it('🔴 un cupón existente con OTRO monto da COUPON_CONFLICT y NUNCA se borra', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    mockCouponRetrieve.mockResolvedValue({ id: 'LC_POS22_V1', amount_off: 999, currency: 'mxn', duration: 'repeating', duration_in_months: 3, valid: true })

    await expect(activateLaunchCampaign('lc-1', 'staff-1')).rejects.toMatchObject({ statusCode: 409, code: 'LAUNCH_CAMPAIGN_COUPON_CONFLICT' })
    // 🔴 La afirmación que de verdad protege dinero: borrar un cupón vivo le sube el precio, en
    // el siguiente ciclo, a todos los clientes que ya lo llevan puesto.
    expect(mockCouponDel).not.toHaveBeenCalled()
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('un cupón existente que YA coincide se reutiliza sin crear otro', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockResolvedValue(ficha({ status: 'ACTIVE' }) as never)
    mockCouponRetrieve.mockResolvedValue({ id: 'LC_POS22_V1', amount_off: AMOUNT_OFF, currency: 'mxn', duration: 'repeating', duration_in_months: 3, valid: true })

    await activateLaunchCampaign('lc-1', 'staff-1')
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalled()
  })

  it.each([
    ['no es inclusive', { ...precioBueno, tax_behavior: 'exclusive' }],
    ['no es mensual', { ...precioBueno, recurring: { interval: 'year' } }],
    ['no es MXN', { ...precioBueno, currency: 'usd' }],
    ['no es mayor que el anunciado', { ...precioBueno, unit_amount: 2200 }],
  ])('precio de Stripe que %s → PLAN_PRICE_UNAVAILABLE y cero cupones', async (_caso, precio) => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    mockPriceList.mockResolvedValue({ data: [precio] })

    await expect(activateLaunchCampaign('lc-1')).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PRICE_UNAVAILABLE' })
    expect(mockCouponCreate).not.toHaveBeenCalled()
  })

  it('🔴 reactivar con un precio de lista distinto del snapshot → PLAN_PRICE_MISMATCH', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(
      ficha({ status: 'PAUSED', stripeCouponId: 'LC_POS22_V1', listPriceCentsSnapshot: LISTA, discountAmountCents: AMOUNT_OFF, activatedAt: new Date() }) as never,
    )
    mockCouponRetrieve.mockResolvedValue({ id: 'LC_POS22_V1', valid: true })
    mockPriceList.mockResolvedValue({ data: [{ ...precioBueno, unit_amount: 129999 }] })

    await expect(activateLaunchCampaign('lc-1')).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PRICE_MISMATCH' })
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it.each([['ACTIVE'], ['ENDED']])('activar desde %s → BAD_STATE', async estado => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: estado }) as never)
    await expect(activateLaunchCampaign('lc-1')).rejects.toMatchObject({ code: 'LAUNCH_CAMPAIGN_BAD_STATE' })
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('una ficha vencida no se activa', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ validUntil: new Date('2020-01-01T00:00:00Z') }) as never)
    await expect(activateLaunchCampaign('lc-1')).rejects.toMatchObject({ code: 'LAUNCH_CAMPAIGN_EXPIRED' })
    expect(mockCouponCreate).not.toHaveBeenCalled()
  })

  it('🔴 un error de Stripe que NO es «no existe» sube: «no pude ver» ≠ «no existe»', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    mockCouponRetrieve.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'api_connection_error' }))

    await expect(activateLaunchCampaign('lc-1')).rejects.toThrow('timeout')
    expect(mockCouponCreate).not.toHaveBeenCalled()
  })

  it('el CAS obsoleto (alguien editó la ficha) responde 409 STALE', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    mockCouponRetrieve.mockRejectedValue(Object.assign(new Error('nope'), { code: 'resource_missing' }))
    prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(activateLaunchCampaign('lc-1')).rejects.toMatchObject({ code: 'LAUNCH_CAMPAIGN_STALE' })
  })
})

describe('previewLaunchOffer', () => {
  it('sólo LEE de Stripe y devuelve los montos del ejemplo del contrato', async () => {
    const p = await previewLaunchOffer({ planTier: 'PRO', advertisedPriceCents: ANUNCIADO, discountMonths: 3, code: 'POS22' })
    expect(p).toMatchObject({
      listPriceCents: LISTA,
      discountAmountCents: AMOUNT_OFF,
      firstChargeCents: 2200,
      promoTotalCents: 6600,
      renewalMonthlyCents: LISTA,
      couponId: 'LC_POS22_V1',
    })
    expect(p.promo).toMatchObject({ subtotalCents: 1897, ivaCents: 303, ivaExact: false })
    // $22.00 es de los precios cuyo desglose no se puede rotular «16 %»: se avisa a tiempo.
    expect(p.problems).toHaveLength(1)
    expect(mockCouponCreate).not.toHaveBeenCalled()
  })

  it('un precio con desglose exacto no produce avisos', async () => {
    const p = await previewLaunchOffer({ planTier: 'PRO', advertisedPriceCents: 2320, discountMonths: 3 })
    expect(p.promo.ivaExact).toBe(true)
    expect(p.problems).toEqual([])
  })
})

describe('launchCouponId', () => {
  it('versiona el id: es lo que ata cada redención a lo que se consintió', () => {
    expect(launchCouponId('POS22', 1)).toBe('LC_POS22_V1')
    expect(launchCouponId('POS22', 2)).toBe('LC_POS22_V2')
  })
})

/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #9): el cupón es DINERO DESCONTADO, no una promesa de
 * precio trasladable.
 *
 * `LC_POS22_V1` descuenta $1,136.84 y se crea **sin `applies_to`**: Stripe se lo aplica a CUALQUIER
 * producto de la suscripción. Como la actualización de precio conserva los descuentos, si ese mismo
 * cupón sobrevive a un cambio de plan:
 *
 *   · sobre PREMIUM mensual el importe recurrente sería **$834**, no $22;
 *   · sobre un paquete de $500 se lo comería entero.
 *
 * Acotarlo al producto del plan que la campaña vende es la diferencia entre «tres meses de
 * descuento en ESTE plan» y «$1,136.84 de saldo a favor sobre lo que sea que contrate después».
 *
 * ⚠️ Límite declarado: Stripe NO deja modificar `applies_to` de un cupón YA creado. Las campañas
 * activadas antes de este cambio (p. ej. la `LC_POS22_V1` de QA) conservan el cupón abierto; el
 * candado protege a las que se activen de aquí en adelante.
 */
describe('el cupón queda acotado al producto que la campaña vende', () => {
  it('🔴 se crea con `applies_to` del producto del plan, no abierto a cualquiera', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockResolvedValue(ficha({ status: 'ACTIVE' }) as never)
    mockCouponRetrieve.mockRejectedValue(Object.assign(new Error('No such coupon'), { code: 'resource_missing' }))

    await activateLaunchCampaign('lc-1', 'staff-1')

    const cuerpo = mockCouponCreate.mock.calls[0]?.[0]
    expect(cuerpo?.applies_to).toEqual({ products: ['prod_plan_pro'] })
  })
})
