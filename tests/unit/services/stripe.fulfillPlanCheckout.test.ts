/**
 * Entrega del checkout de PLAN (`fulfillPlanCheckout` → `entregarSuscripcionDePlan`).
 *
 * Historia que estas pruebas conservan: el hueco original (nada creaba la fila PLAN_PRO), las auditorías 11ª-14ª de
 * Codex (no conceder sobre una suscripción no vigente; guardar el vínculo de una recuperable sin gastar reintentos;
 * CAS sobre `updatedAt` leído ANTES de Stripe) y, desde el 22-sep (V5-A, diseño v5.2), las DOS filas de plan:
 * el tier sale del PRECIO vigente y nunca se pisa otra obligación viva — con dos pestañas pagadas, la segunda
 * REAPUNTABA la fila y la primera quedaba cobrando sin representación.
 */

const suscripciones = new Map<string, any>()
const mockSubRetrieve = jest.fn()
const mockSessionRetrieve = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { create: jest.fn(), retrieve: mockSubRetrieve },
    prices: { list: jest.fn() },
    checkout: { sessions: { retrieve: mockSessionRetrieve } },
  }))
})
const vf = { findMany: jest.fn(), updateMany: jest.fn(), create: jest.fn(), upsert: jest.fn() }
const mockQueryRaw = jest.fn()
const mockExecuteRaw = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => {
  const db: any = { venueFeature: vf, feature: { findMany: jest.fn() }, venue: { findUnique: jest.fn() } }
  db.$transaction = (cb: (tx: unknown) => unknown) => cb(db)
  db.$queryRaw = (...a: unknown[]) => mockQueryRaw(...a)
  db.$executeRaw = (...a: unknown[]) => mockExecuteRaw(...a)
  return { __esModule: true, default: db }
})
const mockRegistrar = jest.fn()
const mockAvisar = jest.fn()
const mockCerrar = jest.fn()
jest.mock('../../../src/services/access/conflictosDeObligacion.service', () => ({
  registrarConflictoDeObligacion: (...a: unknown[]) => mockRegistrar(...a),
  avisarConflictoCreado: (...a: unknown[]) => mockAvisar(...a),
  cerrarConflictoEntregado: (...a: unknown[]) => mockCerrar(...a),
  cerrarConflictoTerminado: jest.fn(),
}))

import { fulfillPlanCheckout, suscripcionVendeElPlan } from '../../../src/services/stripe.service'
import prisma from '../../../src/utils/prismaClient'

const LEIDA = new Date('2026-09-19T10:00:00.000Z')
const PRO = { id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999, stripeProductId: null }
const PREMIUM = { id: 'feat-premium', code: 'PLAN_PREMIUM', monthlyPrice: 1999, stripeProductId: null }

/** Suscripción de Stripe de UN ítem de plan (el tier sale de su lookup_key, como en producción). */
const sub = (id: string, status: string, lookup = 'plan_pro_monthly', extra: any = {}) => ({
  id,
  status,
  customer: 'cus_1',
  trial_end: null,
  items: { data: [{ price: { id: `price_${lookup}`, lookup_key: lookup, product: 'prod_x' } }] },
  ...extra,
})
const conSuscripciones = (...subs: any[]) => {
  for (const s of subs) suscripciones.set(s.id, s)
}
/** Filas de plan del negocio: `{ PRO: { vinculo, active, suspendedAt? } }`. */
const conFilas = (
  filas: Partial<
    Record<
      'PRO' | 'PREMIUM',
      { vinculo: string | null; active: boolean; suspendedAt?: Date | null; gracePeriodEndsAt?: Date | null; paymentFailureCount?: number }
    >
  >,
) =>
  vf.findMany.mockResolvedValue(
    Object.entries(filas).map(([t, f]) => ({
      id: t === 'PRO' ? 'vf-pro' : 'vf-premium',
      featureId: t === 'PRO' ? 'feat-pro' : 'feat-premium',
      active: f!.active,
      stripeSubscriptionId: f!.vinculo,
      suspendedAt: f!.suspendedAt ?? null,
      gracePeriodEndsAt: f!.gracePeriodEndsAt ?? null,
      paymentFailureCount: f!.paymentFailureCount ?? 0,
      updatedAt: LEIDA,
    })),
  )
const makeSession = (overrides: any = {}) =>
  ({
    id: 'cs_test_123',
    object: 'checkout.session',
    mode: 'subscription',
    subscription: 'sub_new',
    metadata: { tierCode: 'PLAN_PRO', venueId: 'v1' },
    ...overrides,
  }) as any
const escritura = (id: string) => vf.updateMany.mock.calls.find(c => c[0].where.id === id)?.[0]

beforeEach(() => {
  jest.clearAllMocks()
  suscripciones.clear()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  ;(prisma.feature.findMany as jest.Mock).mockResolvedValue([PRO, PREMIUM])
  vf.findMany.mockResolvedValue([])
  vf.updateMany.mockResolvedValue({ count: 1 })
  vf.create.mockResolvedValue({})
  mockRegistrar.mockResolvedValue('CREADO')
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ stripeCustomerId: 'cus_1' })
  mockQueryRaw.mockResolvedValue([{}])
  mockExecuteRaw.mockResolvedValue(0)
  mockSubRetrieve.mockImplementation(async (id: string) => {
    const s = suscripciones.get(id)
    if (!s)
      throw Object.assign(new Error('No such subscription'), {
        code: 'resource_missing',
        statusCode: 404,
        type: 'StripeInvalidRequestError',
      })
    return s
  })
})

describe('fulfillPlanCheckout — lo de siempre', () => {
  it('sin fila: CREA la fila PRO activa con la suscripción y el precio (pagado, sin prueba)', async () => {
    conSuscripciones(sub('sub_new', 'active'))

    const result = await fulfillPlanCheckout(makeSession())

    expect(mockSubRetrieve).toHaveBeenCalledWith(
      'sub_new',
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }),
    )
    expect(vf.create.mock.calls[0][0].data).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-pro',
      active: true,
      monthlyPrice: 999,
      stripeSubscriptionId: 'sub_new',
      stripePriceId: 'price_plan_pro_monthly',
      endDate: null,
      trialEndDate: null,
      suspendedAt: null,
      paymentFailureCount: 0,
    })
    expect(result).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-pro',
      featureCode: 'PLAN_PRO',
      subscriptionId: 'sub_new',
      endDate: null,
    })
  })

  it('en prueba: fija endDate/trialEndDate', async () => {
    const fin = Math.floor(Date.now() / 1000) + 30 * 86400
    conSuscripciones(sub('sub_new', 'trialing', 'plan_pro_annual', { trial_end: fin }))

    const result = await fulfillPlanCheckout(makeSession())

    const data = vf.create.mock.calls[0][0].data
    expect(data.endDate).toEqual(new Date(fin * 1000))
    expect(data.trialEndDate).toEqual(new Date(fin * 1000))
    expect(result?.endDate).toEqual(new Date(fin * 1000))
  })

  it('🔴 el tier sale del PRECIO vigente, no de la metadata (que queda vieja tras un cambio de plan)', async () => {
    conSuscripciones(sub('sub_new', 'active', 'plan_premium_monthly'))

    const result = await fulfillPlanCheckout(makeSession({ metadata: { tierCode: 'PLAN_PRO', venueId: 'v1' } }))

    expect(vf.create.mock.calls[0][0].data).toMatchObject({ featureId: 'feat-premium', monthlyPrice: 1999 })
    expect(result?.featureCode).toBe('PLAN_PREMIUM')
  })

  it('expande la sesión cuando el id de la suscripción no viene', async () => {
    mockSessionRetrieve.mockResolvedValue({ id: 'cs_test_123', subscription: 'sub_from_expand' })
    conSuscripciones(sub('sub_from_expand', 'active'))

    const result = await fulfillPlanCheckout(makeSession({ subscription: null }))

    expect(mockSessionRetrieve).toHaveBeenCalledWith('cs_test_123', { expand: ['subscription'] })
    expect(result?.subscriptionId).toBe('sub_from_expand')
  })

  it('sin id de suscripción: null y no escribe', async () => {
    mockSessionRetrieve.mockResolvedValue({ id: 'cs_test_123', subscription: null })

    await expect(fulfillPlanCheckout(makeSession({ subscription: null }))).resolves.toBeNull()
    expect(vf.updateMany).not.toHaveBeenCalled()
    expect(vf.create).not.toHaveBeenCalled()
  })

  it('sin venueId en la metadata: null y ni consulta Stripe', async () => {
    await expect(fulfillPlanCheckout(makeSession({ metadata: { tierCode: 'PLAN_PRO' } }))).resolves.toBeNull()
    expect(mockSubRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 lee las filas ANTES de consultar Stripe (si no, el CAS vigila la ventana equivocada)', async () => {
    const orden: string[] = []
    vf.findMany.mockImplementation(async () => {
      orden.push('filas')
      return []
    })
    mockSubRetrieve.mockImplementation(async () => {
      orden.push('stripe')
      return sub('sub_new', 'active')
    })

    await fulfillPlanCheckout(makeSession())
    expect(orden).toEqual(['filas', 'stripe'])
  })

  it('escribe con CAS sobre el `updatedAt` leído (no un upsert ciego)', async () => {
    conFilas({ PRO: { vinculo: null, active: false } })
    conSuscripciones(sub('sub_new', 'active'))

    await fulfillPlanCheckout(makeSession())

    expect(escritura('vf-pro')).toMatchObject({
      where: { id: 'vf-pro', updatedAt: LEIDA },
      data: expect.objectContaining({ active: true }),
    })
    expect(vf.upsert).not.toHaveBeenCalled()
  })

  it('🔴 si la fila cambió mientras consultábamos Stripe: NO concede y se reintenta', async () => {
    conFilas({ PRO: { vinculo: 'sub_new', active: true } })
    conSuscripciones(sub('sub_new', 'active'))
    vf.updateMany.mockResolvedValue({ count: 0 })

    await expect(fulfillPlanCheckout(makeSession())).rejects.toThrow(/cambió|reintent/i)
  })

  it('sin fila la CREA; si otro evento se adelanta (P2002) se reintenta', async () => {
    conSuscripciones(sub('sub_new', 'active'))
    vf.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))

    await expect(fulfillPlanCheckout(makeSession())).rejects.toThrow(/reintent/i)
  })
})

describe('🔴 no se concede sobre una suscripción que no está vigente', () => {
  it.each(['canceled', 'incomplete_expired'])('con `%s` (terminal) no escribe nada y devuelve null', async estado => {
    conSuscripciones(sub('sub_new', estado))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(vf.updateMany).not.toHaveBeenCalled()
    expect(vf.create).not.toHaveBeenCalled()
  })

  it.each(['past_due', 'unpaid', 'incomplete', 'paused'])(
    'con `%s` (recuperable) guarda el VÍNCULO sin conceder y NO lanza',
    async estado => {
      conFilas({ PRO: { vinculo: null, active: false } })
      conSuscripciones(sub('sub_new', estado))

      await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
      const { where, data } = escritura('vf-pro')
      expect(where).toMatchObject({ id: 'vf-pro', updatedAt: LEIDA })
      // Obligación NUEVA: se liga sin conceder y con su propia cobranza, sin heredar marcas de otra (Codex, P1-2).
      expect(data).toMatchObject({
        stripeSubscriptionId: 'sub_new',
        active: false,
        suspendedAt: null,
        gracePeriodEndsAt: null,
        paymentFailureCount: 0,
      })
    },
  )

  it('🔴 recuperable con el MISMO vínculo en un plan activo: no se toca (la cobranza la lleva su manejador)', async () => {
    conFilas({ PRO: { vinculo: 'sub_new', active: true } })
    conSuscripciones(sub('sub_new', 'past_due'))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(vf.updateMany).not.toHaveBeenCalled()
    expect(vf.create).not.toHaveBeenCalled()
  })
})

describe('🔴 V5-A: nunca pisar otra obligación viva (dos pestañas, dos checkouts legacy)', () => {
  it('🔴 la fila PRO ya liga OTRA suscripción viva (la primera pestaña): conflicto durable, la fila NO se toca', async () => {
    conFilas({ PRO: { vinculo: 'sub_primera', active: true } })
    conSuscripciones(sub('sub_primera', 'active'), sub('sub_new', 'active'))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()

    expect(vf.updateMany).not.toHaveBeenCalled()
    expect(vf.create).not.toHaveBeenCalled()
    expect(mockRegistrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        venueId: 'v1',
        subscriptionId: 'sub_new',
        kind: 'DUPLICATE_PLAN',
        conflictsWith: ['sub_primera'],
        featureCode: 'PLAN_PRO',
      }),
    )
  })

  it('🔴 el OTRO tier tiene un plan vivo (checkouts legacy PRO y PREMIUM pagados): conflicto, no se crea un segundo plan', async () => {
    conFilas({ PRO: { vinculo: 'sub_pro', active: true } })
    conSuscripciones(sub('sub_pro', 'active'), sub('sub_new', 'active', 'plan_premium_monthly'))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(vf.create).not.toHaveBeenCalled()
    expect(mockRegistrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'DUPLICATE_PLAN', conflictsWith: ['sub_pro'] }),
    )
  })

  it('un vínculo viejo TERMINADO se sustituye', async () => {
    conFilas({ PRO: { vinculo: 'sub_vieja', active: false } })
    conSuscripciones(sub('sub_vieja', 'canceled'), sub('sub_new', 'active'))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toMatchObject({ subscriptionId: 'sub_new' })
    expect(escritura('vf-pro').data).toMatchObject({ stripeSubscriptionId: 'sub_new', active: true })
    expect(mockRegistrar).not.toHaveBeenCalled()
  })

  it('🔴 un vínculo que Stripe no pudo confirmar: no se pisa y se reintenta', async () => {
    conFilas({ PRO: { vinculo: 'sub_vieja', active: false } })
    conSuscripciones(sub('sub_new', 'active'))
    mockSubRetrieve.mockImplementation(async (id: string) => {
      if (id === 'sub_vieja') throw new Error('socket hang up')
      return suscripciones.get(id)
    })

    await expect(fulfillPlanCheckout(makeSession())).rejects.toThrow(/reintent/i)
    expect(vf.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 cambio de tier: la suscripción estaba ligada en PRO y hoy vende PREMIUM ⇒ PRO suelta y PREMIUM la liga', async () => {
    conFilas({ PRO: { vinculo: 'sub_new', active: true } })
    conSuscripciones(sub('sub_new', 'active', 'plan_premium_monthly'))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toMatchObject({ featureCode: 'PLAN_PREMIUM' })
    expect(escritura('vf-pro').data).toEqual({ stripeSubscriptionId: null, stripeSubscriptionItemId: null, active: false })
    expect(vf.create.mock.calls[0][0].data).toMatchObject({ featureId: 'feat-premium', stripeSubscriptionId: 'sub_new', active: true })
    // Primero se suelta, luego se liga: el vínculo es único.
    expect(vf.updateMany.mock.invocationCallOrder[0]).toBeLessThan(vf.create.mock.invocationCallOrder[0])
  })

  it('🔴 una pagada que habilita sustituye la concesión LOCAL del otro tier (cortesía o prueba sin Stripe)', async () => {
    conFilas({ PREMIUM: { vinculo: null, active: true } })
    conSuscripciones(sub('sub_new', 'active'))

    await fulfillPlanCheckout(makeSession())

    expect(escritura('vf-premium').data).toEqual({ active: false })
    expect(vf.create.mock.calls[0][0].data).toMatchObject({ featureId: 'feat-pro', active: true })
  })

  it('🔴 una suscripción con un plan Y otra cosa (o un producto desconocido) no se representa: conflicto UNKNOWN_PRODUCT', async () => {
    conSuscripciones({
      ...sub('sub_new', 'active'),
      items: {
        data: [
          { price: { id: 'p1', lookup_key: 'plan_pro_monthly', product: 'prod_x' } },
          { price: { id: 'p2', lookup_key: null, product: 'prod_misterio' } },
        ],
      },
    })

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(vf.create).not.toHaveBeenCalled()
    expect(vf.updateMany).not.toHaveBeenCalled()
    expect(mockRegistrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subscriptionId: 'sub_new', kind: 'UNKNOWN_PRODUCT' }),
    )
  })

  it('🔴 Codex P1-2: SUSTITUIR un vínculo terminado NO hereda sus marcas de impago (el job cancelaría la suscripción NUEVA)', async () => {
    conFilas({ PRO: { vinculo: 'sub_vieja', active: false } })
    conSuscripciones(sub('sub_vieja', 'canceled'), sub('sub_new', 'incomplete'))

    await fulfillPlanCheckout(makeSession())

    expect(escritura('vf-pro').data).toMatchObject({
      stripeSubscriptionId: 'sub_new',
      stripeSubscriptionItemId: null,
      active: false,
      suspendedAt: null,
      gracePeriodEndsAt: null,
      paymentFailureCount: 0,
      endDate: null,
    })
  })

  it('🔴 Codex P1-2: SUSTITUIR concediendo tampoco hereda el ítem de la suscripción anterior', async () => {
    conFilas({ PRO: { vinculo: 'sub_vieja', active: false } })
    conSuscripciones(sub('sub_vieja', 'canceled'), sub('sub_new', 'active'))

    await fulfillPlanCheckout(makeSession())

    expect(escritura('vf-pro').data).toMatchObject({ stripeSubscriptionId: 'sub_new', stripeSubscriptionItemId: null, active: true })
  })

  it('🔴 una prueba (`trialing`) NO levanta la suspensión por impago del mismo vínculo (lo que ya exigían los webhooks)', async () => {
    conFilas({ PRO: { vinculo: 'sub_new', active: false, suspendedAt: new Date('2026-09-18T00:00:00Z') } })
    conSuscripciones(sub('sub_new', 'trialing', 'plan_pro_monthly', { trial_end: Math.floor(Date.now() / 1000) + 86400 }))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(escritura('vf-pro')).toBeUndefined()
  })

  it('con `active` sí la levanta: el dinero está al corriente', async () => {
    conFilas({ PRO: { vinculo: 'sub_new', active: false, suspendedAt: new Date('2026-09-18T00:00:00Z') } })
    conSuscripciones(sub('sub_new', 'active'))

    await expect(fulfillPlanCheckout(makeSession())).resolves.not.toBeNull()
    expect(escritura('vf-pro')!.data).toMatchObject({ active: true, suspendedAt: null })
  })

  it('🔴 una suscripción con más ítems de los que trae la página no se entiende entera: conflicto, sin conceder', async () => {
    conSuscripciones({ ...sub('sub_new', 'active'), items: { ...sub('sub_new', 'active').items, has_more: true } })

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(vf.create).not.toHaveBeenCalled()
    expect(mockRegistrar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'UNKNOWN_PRODUCT' }))
  })

  it('🔴 Codex C10: con VARIOS ítems (todos reconocidos) que ya no respaldan el plan de su fila, esa fila pierde el acceso (y queda en conflicto)', async () => {
    conFilas({ PREMIUM: { vinculo: 'sub_new', active: true } })
    const dosPro = sub('sub_new', 'active')
    conSuscripciones({
      ...dosPro,
      items: { data: [...dosPro.items.data, { price: { id: 'price_2', lookup_key: 'plan_pro_annual', product: 'prod_x' } }] },
    })

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(escritura('vf-premium')).toMatchObject({ where: { id: 'vf-premium', updatedAt: LEIDA }, data: { active: false } })
    expect(mockRegistrar).toHaveBeenCalled()
  })

  /**
   * 🔴 Codex R11 (ronda 2): la entrega clasificaba con un catálogo de SÓLO los dos planes, así que una función normal
   * del catálogo (Inventario) salía `DESCONOCIDO` y la retirada demostrable se saltaba: una fila PREMIUM ligada a una
   * suscripción que hoy vende PRO + Inventario conservaba PREMIUM. El inventario de obligaciones ya clasificaba con el
   * catálogo completo; la entrega no.
   */
  it('🔴 R11: una FUNCIÓN del catálogo junto al plan sí es reconocible: la fila que ya no respalda pierde el acceso', async () => {
    // 🔴 El mock HONRA el `where`: si el servicio sólo pide los dos planes, sólo recibe los dos planes. Sin esto la
    // prueba pasaba por el motivo equivocado — el catálogo le llegaba completo aunque el código nunca lo pidiera.
    const CATALOGO = [PRO, PREMIUM, { code: 'INVENTORY_TRACKING', stripeProductId: 'prod_inv', id: 'feat-inv', monthlyPrice: 99 }]
    ;(prisma.feature.findMany as jest.Mock).mockImplementation(async (args: any) => {
      const pedidos: string[] | undefined = args?.where?.code?.in
      return pedidos ? CATALOGO.filter(f => pedidos.includes(f.code)) : CATALOGO
    })
    conFilas({ PREMIUM: { vinculo: 'sub_new', active: true } })
    const base = sub('sub_new', 'active')
    conSuscripciones({
      ...base,
      items: { data: [...base.items.data, { price: { id: 'price_inv', lookup_key: null, product: 'prod_inv' } }] },
    })

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(escritura('vf-premium')).toMatchObject({ where: { id: 'vf-premium', updatedAt: LEIDA }, data: { active: false } })
  })

  it('…pero si algún ítem no se reconoce, no se retira nada (no es demostrable)', async () => {
    conFilas({ PREMIUM: { vinculo: 'sub_new', active: true } })
    const base = sub('sub_new', 'active')
    conSuscripciones({ ...base, items: { data: [...base.items.data, { price: { id: 'p', lookup_key: null, product: 'prod_misterio' } }] } })

    await fulfillPlanCheckout(makeSession())
    expect(escritura('vf-premium')).toBeUndefined()
  })

  describe('🔴 Codex C9: la MISMA suscripción que cambia de tier se TRASLADA con su cobranza', () => {
    const SUSP = new Date('2026-09-18T00:00:00Z')
    const GRACIA = new Date('2026-09-25T00:00:00Z')

    it('suspendida y ahora en prueba (Premium): la suspensión viaja y NO se concede', async () => {
      conFilas({ PRO: { vinculo: 'sub_new', active: false, suspendedAt: SUSP, gracePeriodEndsAt: GRACIA, paymentFailureCount: 3 } })
      conSuscripciones(sub('sub_new', 'trialing', 'plan_premium_monthly', { trial_end: Math.floor(Date.now() / 1000) + 86400 }))

      await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
      expect(vf.create.mock.calls[0][0].data).toMatchObject({
        featureId: 'feat-premium',
        stripeSubscriptionId: 'sub_new',
        active: false,
        suspendedAt: SUSP,
        gracePeriodEndsAt: GRACIA,
        paymentFailureCount: 3,
      })
      expect(escritura('vf-pro')!.data).toMatchObject({ stripeSubscriptionId: null, active: false })
    })

    it('suspendida y ahora `active` (pagó): sí se levanta y se concede', async () => {
      conFilas({ PRO: { vinculo: 'sub_new', active: false, suspendedAt: SUSP, paymentFailureCount: 3 } })
      conSuscripciones(sub('sub_new', 'active', 'plan_premium_monthly'))

      await expect(fulfillPlanCheckout(makeSession())).resolves.toMatchObject({ featureCode: 'PLAN_PREMIUM' })
      expect(vf.create.mock.calls[0][0].data).toMatchObject({ active: true, suspendedAt: null, paymentFailureCount: 0 })
    })

    it('en mora (recuperable): la cobranza viaja, no se borra', async () => {
      conFilas({ PRO: { vinculo: 'sub_new', active: true, gracePeriodEndsAt: GRACIA, paymentFailureCount: 2 } })
      conSuscripciones(sub('sub_new', 'past_due', 'plan_premium_monthly'))

      await fulfillPlanCheckout(makeSession())
      expect(vf.create.mock.calls[0][0].data).toMatchObject({ gracePeriodEndsAt: GRACIA, paymentFailureCount: 2 })
    })
  })

  it('🔴 Codex P2-5: una suscripción CANCELADA que no se sabe qué vendía igual pierde el acceso de su fila', async () => {
    conFilas({ PRO: { vinculo: 'sub_new', active: true } })
    conSuscripciones({
      ...sub('sub_new', 'canceled'),
      items: { data: [{ price: { id: 'p', lookup_key: null, product: 'prod_misterio' } }] },
    })

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()
    expect(escritura('vf-pro')).toMatchObject({ where: { id: 'vf-pro', updatedAt: LEIDA }, data: { active: false } })
    expect(mockRegistrar).not.toHaveBeenCalled()
  })

  it('🔴 Codex P1-1: toma el candado del NEGOCIO (bloqueante) ANTES de leer las filas y de consultar Stripe', async () => {
    conSuscripciones(sub('sub_new', 'active'))

    await fulfillPlanCheckout(makeSession())

    const sql = (mockQueryRaw.mock.calls[0][0] as string[]).join('?')
    expect(sql).toMatch(/pg_advisory_xact_lock/)
    expect(sql).not.toMatch(/pg_try_advisory/)
    expect(mockQueryRaw.mock.calls[0].slice(1)).toContain('stripe-obligaciones:v1')
    expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(vf.findMany.mock.invocationCallOrder[0])
    expect(vf.findMany.mock.invocationCallOrder[0]).toBeLessThan(mockSubRetrieve.mock.invocationCallOrder[0])
  })
})

describe('🔴 Codex C11: un conflicto se AVISA a una persona y se CIERRA cuando por fin se entrega', () => {
  it('dos planes vivos: el conflicto recién creado se avisa (bitácora + correo a operaciones) con quién choca', async () => {
    conFilas({ PRO: { vinculo: 'sub_primera', active: true } })
    conSuscripciones(sub('sub_primera', 'active'), sub('sub_new', 'active'))

    await fulfillPlanCheckout(makeSession())

    expect(mockAvisar).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'v1', subscriptionId: 'sub_new', kind: 'DUPLICATE_PLAN', conflictsWith: ['sub_primera'] }),
    )
    expect(mockCerrar).not.toHaveBeenCalled()
  })

  it('producto desconocido: también se avisa', async () => {
    conSuscripciones({
      ...sub('sub_new', 'active'),
      items: { has_more: false, data: [{ price: { id: 'p2', lookup_key: null, product: 'prod_misterio' } }] },
    })

    await fulfillPlanCheckout(makeSession())

    expect(mockAvisar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_new', kind: 'UNKNOWN_PRODUCT' }))
  })

  it('un conflicto que YA existía no se vuelve a avisar (no se inunda el correo en cada webhook)', async () => {
    mockRegistrar.mockResolvedValue('ACTUALIZADO')
    conFilas({ PRO: { vinculo: 'sub_primera', active: true } })
    conSuscripciones(sub('sub_primera', 'active'), sub('sub_new', 'active'))

    await fulfillPlanCheckout(makeSession())

    expect(mockAvisar).not.toHaveBeenCalled()
  })

  it('🔴 cuando la entrega CONCEDE, cierra dentro de la misma transacción el conflicto pendiente de esa suscripción', async () => {
    conSuscripciones(sub('sub_new', 'active'))

    await expect(fulfillPlanCheckout(makeSession())).resolves.not.toBeNull()

    expect(mockCerrar).toHaveBeenCalledWith(expect.anything(), 'sub_new')
    expect(mockAvisar).not.toHaveBeenCalled()
  })
})

describe('🔴 Codex R6: la entrega sólo concede una suscripción que ES del negocio', () => {
  it('trae el venueId de OTRO negocio en su metadata: no concede, no escribe y no registra conflicto aquí', async () => {
    conSuscripciones(sub('sub_new', 'active', 'plan_pro_monthly', { metadata: { venueId: 'v_otro' } }))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()

    expect(vf.create).not.toHaveBeenCalled()
    expect(vf.updateMany).not.toHaveBeenCalled()
    expect(mockRegistrar).not.toHaveBeenCalled()
  })

  it('sin venueId en la metadata (suscripción vieja) y de OTRO cliente de Stripe: no concede', async () => {
    conSuscripciones(sub('sub_new', 'active', 'plan_pro_monthly', { customer: 'cus_ajeno' }))

    await expect(fulfillPlanCheckout(makeSession())).resolves.toBeNull()

    expect(vf.create).not.toHaveBeenCalled()
  })

  it('con SU venueId en la metadata concede aunque el cliente de Stripe sea otro (un cliente histórico del negocio)', async () => {
    conSuscripciones(sub('sub_new', 'active', 'plan_pro_monthly', { customer: 'cus_viejo', metadata: { venueId: 'v1' } }))

    await expect(fulfillPlanCheckout(makeSession())).resolves.not.toBeNull()
  })
})

describe('suscripcionVendeElPlan — la regla que usan los webhooks para no reactivar la fila equivocada', () => {
  const item = (lookupKey: string | null, productId = 'prod_x') => ({ priceId: `price_${lookupKey}`, productId, lookupKey })
  const vigente = (items: any[], itemsCompletos = true) => ({ items, itemsCompletos })

  it('vende ese plan (por lookup_key): sí para su código, no para el otro', async () => {
    await expect(suscripcionVendeElPlan(vigente([item('plan_pro_monthly')]), 'PLAN_PRO')).resolves.toBe(true)
    await expect(suscripcionVendeElPlan(vigente([item('plan_pro_monthly')]), 'PLAN_PREMIUM')).resolves.toBe(false)
  })

  it('reconoce también por el PRODUCTO del catálogo', async () => {
    ;(prisma.feature.findMany as jest.Mock).mockResolvedValue([{ ...PREMIUM, stripeProductId: 'prod_premium' }, PRO])
    await expect(suscripcionVendeElPlan(vigente([item(null, 'prod_premium')]), 'PLAN_PREMIUM')).resolves.toBe(true)
  })

  it('🔴 algo que no reconoce, un plan junto con otra cosa, o una página incompleta: NO (decide la entrega)', async () => {
    await expect(suscripcionVendeElPlan(vigente([item(null, 'prod_misterio')]), 'PLAN_PRO')).resolves.toBe(false)
    await expect(suscripcionVendeElPlan(vigente([item('plan_pro_monthly'), item(null, 'prod_misterio')]), 'PLAN_PRO')).resolves.toBe(false)
    await expect(suscripcionVendeElPlan(vigente([item('plan_pro_monthly')], false), 'PLAN_PRO')).resolves.toBe(false)
  })
})
