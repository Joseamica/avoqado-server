/**
 * S5 — la lectura pública de la oferta (spec 2026-09-17 § 3.3).
 *
 * 🔴 Lo que estas pruebas guardan, y es lo que un revisor de anuncios comprueba: una oferta que
 * ya no se puede vender NO devuelve ni un número de precio.
 */
import { getLaunchOffer } from '@/controllers/public/launchOffer.public.controller'
import { prismaMock } from '@tests/__helpers__/setup'

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
    advertisedPriceCents: 2200,
    discountMonths: 3,
    currency: 'MXN',
    offerVersion: 1,
    listPriceCentsSnapshot: 115884,
    discountAmountCents: 113684,
    stripePriceId: 'price_x',
    stripeCouponId: 'LC_POS22_V1',
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validUntil: new Date('2099-10-31T06:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 0,
    headline: 'Tu punto de venta a $22 al mes',
    subheadline: null,
    bullets: [],
    status: 'ACTIVE',
    statusReason: null,
    activatedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  }
}

function contexto() {
  const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  return { req: { params: { slug: 'pos-22' } } as never, res: res as never, next, res_: res }
}

beforeEach(() => jest.clearAllMocks())

describe('GET /public/launch-offers/:slug', () => {
  it('una ficha ACTIVE devuelve la vista exacta del contrato', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    const { req, res, next, res_ } = contexto()

    await getLaunchOffer(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res_.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=60')
    const cuerpo = res_.json.mock.calls[0][0]
    expect(cuerpo.success).toBe(true)
    expect(cuerpo.data).toMatchObject({
      code: 'POS22',
      slug: 'pos-22',
      planTier: 'PRO',
      planName: 'Pro',
      available: true,
      currency: 'MXN',
      ivaIncluded: true,
      requiresCard: true,
      firstChargeCents: 2200,
      limited: true,
    })
    expect(cuerpo.data.promo).toMatchObject({ monthlyCents: 2200, months: 3, subtotalCents: 1897, ivaCents: 303, periodTotalCents: 6600 })
    expect(cuerpo.data.renewal).toMatchObject({ monthlyCents: 115884, subtotalCents: 99900, ivaCents: 15984 })
  })

  it('🔴 NUNCA expone cupo, conteo, ids internos ni el cupón de Stripe (D10)', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ redemptionCount: 42 }) as never)
    const { req, res, next, res_ } = contexto()

    await getLaunchOffer(req, res, next)

    const texto = JSON.stringify(res_.json.mock.calls[0][0])
    for (const prohibido of ['redemptionCap', 'redemptionCount', 'stripeCouponId', 'LC_POS22_V1', 'price_x', '"id"', '42']) {
      expect(texto).not.toContain(prohibido)
    }
  })

  it('🔴 una ficha DRAFT es 404, no «no disponible»: su dirección no existe para el mundo', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'DRAFT' }) as never)
    const { req, res, next, res_ } = contexto()

    await getLaunchOffer(req, res, next)

    expect(res_.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, code: 'LAUNCH_OFFER_NOT_FOUND' }))
    expect(res_.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=0, s-maxage=30')
  })

  it('un slug que no existe es 404', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(null as never)
    const { req, res, next } = contexto()
    await getLaunchOffer(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, code: 'LAUNCH_OFFER_NOT_FOUND' }))
  })

  it.each([
    ['PAUSED', { status: 'PAUSED' }, 'PAUSED'],
    ['ENDED', { status: 'ENDED' }, 'ENDED'],
    ['agotada', { redemptionCount: 100 }, 'SOLD_OUT'],
    ['vencida', { validUntil: new Date('2020-01-01T00:00:00Z') }, 'EXPIRED'],
    ['sin empezar', { validFrom: new Date('2099-01-01T00:00:00Z'), validUntil: new Date('2099-06-01T00:00:00Z') }, 'NOT_STARTED'],
  ])('🔴 %s → 200 available:false y SIN una sola llave de precio', async (_caso, overrides, motivo) => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha(overrides) as never)
    const { req, res, next, res_ } = contexto()

    await getLaunchOffer(req, res, next)

    const data = res_.json.mock.calls[0][0].data
    expect(data).toEqual({ code: 'POS22', slug: 'pos-22', available: false, unavailableReason: motivo })
    // La afirmación que importa: cuatro llaves y ninguna más. Un `toMatchObject` dejaría pasar
    // un precio colado, que es exactamente el defecto que esta vista existe para impedir.
    expect(Object.keys(data).sort()).toEqual(['available', 'code', 'slug', 'unavailableReason'])
  })

  it('una ficha marcada ACTIVE sin el snapshot congelado no pinta precio', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ listPriceCentsSnapshot: null, discountAmountCents: null }) as never)
    const { req, res, next, res_ } = contexto()

    await getLaunchOffer(req, res, next)

    expect(res_.json.mock.calls[0][0].data).toMatchObject({ available: false, unavailableReason: 'NOT_PUBLISHED' })
  })
})
