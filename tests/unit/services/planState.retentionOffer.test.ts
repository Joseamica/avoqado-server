/**
 * Unit tests for applyRetentionOffer (cancellation-retention flow).
 *
 * Strategy: the global setup (tests/__helpers__/setup.ts) mocks prismaClient + logger.
 * We additionally mock the stripe.service module so we can drive the Stripe-side helpers
 * (retrievePlanSubscription / applySubscriptionCoupon / pauseSubscriptionCollection) and the
 * access/basePlan.service (getVenueBaseTier), then assert the service:
 *   - applies RETENTION_30_3M on the 'discount' offer when eligible (tenure ≥30d, no discount),
 *   - pauses collection on the 'pause' offer,
 *   - blocks (BadRequestError) when the subscription already carries a discount (non-stackable),
 *   - blocks (BadRequestError) when subscription tenure < 30 days (anti-farm),
 *   - blocks (BadRequestError) when the venue has no active base plan,
 *   - blocks (BadRequestError) when there is no Stripe subscription.
 */

// --- Mocks ---------------------------------------------------------------

const mockGetVenueBaseTier = jest.fn()
// basePlan.service exports both the access helpers AND the constants/derivePlanState that
// planState.service imports — preserve the real module and only override getVenueBaseTier.
jest.mock('@/services/access/basePlan.service', () => {
  const actual = jest.requireActual('@/services/access/basePlan.service')
  return { __esModule: true, ...actual, getVenueBaseTier: (...args: any[]) => mockGetVenueBaseTier(...args) }
})

const mockApplySubscriptionCoupon = jest.fn()
const mockPauseSubscriptionCollection = jest.fn()
const mockRetrievePlanSubscription = jest.fn()
const mockSetSubscriptionCancelAtPeriodEnd = jest.fn()
const mockCreateWinbackPromotionCode = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  applySubscriptionCoupon: (...a: any[]) => mockApplySubscriptionCoupon(...a),
  pauseSubscriptionCollection: (...a: any[]) => mockPauseSubscriptionCollection(...a),
  retrievePlanSubscription: (...a: any[]) => mockRetrievePlanSubscription(...a),
  setSubscriptionCancelAtPeriodEnd: (...a: any[]) => mockSetSubscriptionCancelAtPeriodEnd(...a),
  createWinbackPromotionCode: (...a: any[]) => mockCreateWinbackPromotionCode(...a),
}))

// Email + notification: applyRetentionOffer doesn't email, but planState.service imports them
// at module load, so provide light stubs to keep the module graph happy.
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendPlanCancellationEmail: jest.fn() } }))
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn(),
}))

import { prismaMock } from '../../__helpers__/setup'
import { applyRetentionOffer, RETENTION_DISCOUNT_COUPON } from '@/services/dashboard/planState.service'
import { BadRequestError } from '@/errors/AppError'

let pausaPrevia: { createdAt: Date } | null = null
const VENUE_ID = 'venue_1'
const SUB_ID = 'sub_123'

const DAY_MS = 86400000
/** Created 60 days ago → well past the 30-day tenure threshold (eligible). */
const TENURED_CREATED_AT = new Date(Date.now() - 60 * DAY_MS)
/** Created 5 days ago → inside the first billing cycle (NOT eligible for discount). */
const FRESH_CREATED_AT = new Date(Date.now() - 5 * DAY_MS)

// A PLAN_PRO VenueFeature row as returned by findPlanProFeature's select.
const planProFeature = {
  id: 'vf_1',
  active: true,
  endDate: null,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: SUB_ID,
  feature: { code: 'PLAN_PRO', name: 'Plan Avoqado Pro' },
}

/** Build a retrievePlanSubscription summary with sensible defaults. */
function subSummary(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    createdAt: TENURED_CREATED_AT,
    hasActiveDiscount: false,
    /** 🔴 Codex N3: hasta ahora el servidor NO leía si ya había una pausa, y por eso se podía extender sin fin. */
    pausedUntil: null as Date | null,
    interval: 'month',
    grossAmountCents: 115884,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  // Active base plan by default.
  mockGetVenueBaseTier.mockResolvedValue('PRO')
  mockApplySubscriptionCoupon.mockResolvedValue({ id: SUB_ID })
  mockPauseSubscriptionCollection.mockResolvedValue({ id: SUB_ID })
  // Eligible by default: tenured (60d) + no active discount.
  mockRetrievePlanSubscription.mockResolvedValue(subSummary())
  // getPlanState (called at the end) reads the VenueFeature + venue + Stripe sub.
  prismaMock.venue.findUnique.mockResolvedValue({ id: VENUE_ID, stripeCustomerId: 'cus_1' })
  prismaMock.venueFeature.findMany.mockResolvedValue([planProFeature])
  // 🔴 Codex N3: el tope de frecuencia se lee de la bitácora (sin pausas previas por defecto).
  // El mock HONRA el `where.createdAt.gte`: si no, una pausa vieja se devolvería como si estuviera dentro de la
  // ventana y la prueba pasaría por el motivo equivocado.
  pausaPrevia = null
  prismaMock.activityLog.findFirst.mockImplementation(async (args: any) => {
    if (!pausaPrevia) return null
    const desde: Date | undefined = args?.where?.createdAt?.gte
    return !desde || pausaPrevia.createdAt >= desde ? pausaPrevia : null
  })
})

describe('applyRetentionOffer', () => {
  it('discount offer: applies RETENTION_30_3M when eligible (tenure ≥30d, no discount)', async () => {
    const state = await applyRetentionOffer(VENUE_ID, 'discount')

    expect(mockRetrievePlanSubscription).toHaveBeenCalledWith(SUB_ID)
    expect(mockApplySubscriptionCoupon).toHaveBeenCalledWith(SUB_ID, RETENTION_DISCOUNT_COUPON)
    expect(mockPauseSubscriptionCollection).not.toHaveBeenCalled()
    // Returns the refreshed PlanState envelope.
    expect(state.hasPlan).toBe(true)
  })

  it('defaults to the discount offer when no offer is passed', async () => {
    await applyRetentionOffer(VENUE_ID)
    expect(mockApplySubscriptionCoupon).toHaveBeenCalledWith(SUB_ID, RETENTION_DISCOUNT_COUPON)
  })

  it('pause offer: pauses collection (~2 months) instead of applying a coupon', async () => {
    await applyRetentionOffer(VENUE_ID, 'pause')

    expect(mockPauseSubscriptionCollection).toHaveBeenCalledTimes(1)
    const [subArg, resumesAt] = mockPauseSubscriptionCollection.mock.calls[0]
    expect(subArg).toBe(SUB_ID)
    expect(resumesAt).toBeInstanceOf(Date)
    expect(resumesAt.getTime()).toBeGreaterThan(Date.now())
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
  })

  it('pause offer: allowed even when tenure < 30 days (pause grants no discount to farm)', async () => {
    mockRetrievePlanSubscription.mockResolvedValue(subSummary({ createdAt: FRESH_CREATED_AT }))

    await applyRetentionOffer(VENUE_ID, 'pause')
    expect(mockPauseSubscriptionCollection).toHaveBeenCalledTimes(1)
  })

  it('anti-abuse: blocks with BadRequestError when the subscription already has a discount', async () => {
    mockRetrievePlanSubscription.mockResolvedValue(subSummary({ hasActiveDiscount: true }))

    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toBeInstanceOf(BadRequestError)
    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toThrow('Ya tienes una oferta activa.')
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
    expect(mockPauseSubscriptionCollection).not.toHaveBeenCalled()
  })

  it('anti-farm: blocks the discount offer with BadRequestError when tenure < 30 days', async () => {
    mockRetrievePlanSubscription.mockResolvedValue(subSummary({ createdAt: FRESH_CREATED_AT }))

    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toBeInstanceOf(BadRequestError)
    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toThrow('después de tu primer mes')
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
  })

  it('blocks with BadRequestError when the venue has no active base plan', async () => {
    mockGetVenueBaseTier.mockResolvedValue(null)

    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toBeInstanceOf(BadRequestError)
    // Never reaches the Stripe eligibility read / apply.
    expect(mockRetrievePlanSubscription).not.toHaveBeenCalled()
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
  })

  it('blocks when there is an active plan but no Stripe subscription id', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([{ ...planProFeature, stripeSubscriptionId: null }])

    await expect(applyRetentionOffer(VENUE_ID, 'discount')).rejects.toBeInstanceOf(BadRequestError)
    expect(mockApplySubscriptionCoupon).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 Codex N3 (ronda 4, P1) — y está DESPLEGADO: la oferta de PAUSA dejaba conservar el plan sin pagar de forma
 * indefinida. El único antiabuso era «¿ya tienes un descuento activo?», y una pausa NO es un descuento; nada
 * persistía que ya se hubiera usado (sólo un `ActivityLog` que ningún candado leía); la fecha de reanudación se
 * recalculaba a «hoy + 2 meses» en CADA llamada, así que pedirla otra vez antes de que venciera la extendía; y la
 * fila de `VenueFeature` no se toca, así que el acceso se conserva entero. Con `mark_uncollectible`, esos periodos
 * no se cobran después.
 *
 * 🔑 No se cierra la oferta: existe para no perder a un cliente con problemas de flujo, que es justo nuestro ICP.
 * Lo que le faltaba era TOPE. Y el tope va en el servidor a propósito: este endpoint ya devuelve mensajes que la
 * pantalla muestra, así que no hace falta tocar el dashboard para que el cliente entienda qué pasó.
 */
describe('🔴 N3: la pausa tiene tope', () => {
  it('🔴 no se puede extender una pausa que ya está corriendo', async () => {
    mockRetrievePlanSubscription.mockResolvedValue(subSummary({ pausedUntil: new Date('2026-12-01T00:00:00Z') }))

    await expect(applyRetentionOffer(VENUE_ID, 'pause')).rejects.toThrow(BadRequestError)
    expect(mockPauseSubscriptionCollection).not.toHaveBeenCalled()
  })

  it('🔴 y no se puede pedir otra antes de que pase el periodo mínimo entre pausas', async () => {
    pausaPrevia = { createdAt: new Date(Date.now() - 30 * 24 * 3600_000) }

    await expect(applyRetentionOffer(VENUE_ID, 'pause')).rejects.toThrow(BadRequestError)
    expect(mockPauseSubscriptionCollection).not.toHaveBeenCalled()
  })

  it('una pausa vieja (fuera del periodo mínimo) sí permite otra', async () => {
    pausaPrevia = { createdAt: new Date(Date.now() - 400 * 24 * 3600_000) }

    await applyRetentionOffer(VENUE_ID, 'pause')

    expect(mockPauseSubscriptionCollection).toHaveBeenCalled()
  })

  it('el tope NO estorba a la oferta de descuento (son ofertas distintas)', async () => {
    pausaPrevia = { createdAt: new Date(Date.now() - 30 * 24 * 3600_000) }

    await applyRetentionOffer(VENUE_ID, 'discount')

    expect(mockApplySubscriptionCoupon).toHaveBeenCalled()
  })
})
