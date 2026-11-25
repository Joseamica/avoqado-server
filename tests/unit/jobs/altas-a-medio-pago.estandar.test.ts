/**
 * Planes editables B2, Task 5: el barrido de altas a medio pago cierra un alta ESTÁNDAR con la suscripción de su intento,
 * aunque después se haya publicado otra versión, aunque falte la marca del reto (cobro en el primer `create`, b2-r2 #1),
 * aunque su id nunca se haya guardado (b2-r1 #1) y aunque leer la oferta falle (b2-r9 #3).
 *
 * La entrada real del job: `new AltasAMedioPagoJob({ cron }).runNow()` con su resolver real (`cerrarAltaSinNavegador`, que
 * llama a `activatePlan` con `soloRecuperar`), como `altas-a-medio-pago.campana.test.ts`. La fila del alta es un falso con
 * estado: `findMany` aplica el `where` del job y `updateMany` aplica su CAS, así el id que registra el barrido es el que lee
 * `activatePlan`. Stripe, la entrega, la evidencia del primer cobro (probada en su suite) y los avisos, simulados.
 */
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockSubCreate = jest.fn()
const mockInvList = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: jest.fn() },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: jest.fn() },
    invoices: { list: (...a: unknown[]) => mockInvList(...a), voidInvoice: jest.fn() },
    invoicePayments: { list: jest.fn() },
    creditNotes: { list: jest.fn() },
  })),
)
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
const mockEntregar = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
}))
const mockCubierto = jest.fn()
jest.mock('@/services/onboarding/primerCobroPagado', () => ({ primerCobroCubierto: (...a: unknown[]) => mockCubierto(...a) }))
jest.mock('@/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'negocio-de-prueba', status: 'ONBOARDING' }),
}))
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: null, locale: 'es', venueName: 'Negocio' }),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
}))
jest.mock('@/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobrada: jest.fn().mockResolvedValue({ estado: 'NADA', motivo: 'CIERRE_EN_CURSO' }),
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))

import { AltasAMedioPagoJob } from '@/jobs/altas-a-medio-pago.job'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const PRO_M_V2 = 92684 // 79900 + IVA
const FIN = Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000)
const HACE_UNA_HORA = new Date(Date.now() - 3_600_000)

type Fila = Record<string, unknown> & { id: string; organizationId: string }

/** ¿La fila cumple este `where`? Sólo lo que usan el job y los CAS del alta: igualdad, `null`, `not`, `gte`, `lt`, `OR`, `AND`. */
function cumple(fila: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([campo, cond]) => {
    if (campo === 'OR') return (cond as Record<string, unknown>[]).some(w => cumple(fila, w))
    if (campo === 'AND') return (cond as Record<string, unknown>[]).every(w => cumple(fila, w))
    const valor = fila[campo]
    if (cond === null) return valor === null || valor === undefined
    if (cond instanceof Date) return valor instanceof Date && valor.getTime() === cond.getTime()
    if (typeof cond === 'object') {
      const c = cond as Record<string, unknown>
      if ('not' in c) return c.not === null ? valor !== null && valor !== undefined : valor !== c.not
      if ('gte' in c) return typeof valor === 'number' && valor >= (c.gte as number)
      if ('lt' in c) return valor instanceof Date && valor.getTime() < (c.lt as Date).getTime()
      return false
    }
    return valor === cond
  })
}

let filas: Fila[] = []
/** Un alta a medio pago (quieta, con el lease vencido) del intento 1, de la v2 con su id guardado. */
const altaEnCurso = (o: Record<string, unknown> = {}): Fila => ({
  id: 'op-1',
  organizationId: 'org-1',
  completedAt: null,
  v2SetupData: {},
  launchCampaignId: null,
  termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
  planActivationStatus: 'IN_PROGRESS',
  planActivationAttempt: 1,
  planActivationLeaseUntil: null,
  planStripeSubscriptionId: 'sub_3ds',
  planOfferVersionNumber: 2,
  updatedAt: HACE_UNA_HORA,
  ...o,
})

const precio = (id: string, unitAmount: number) => ({
  id,
  active: true,
  product: 'prod_pro',
  currency: 'mxn',
  recurring: { interval: 'month', interval_count: 1 },
  tax_behavior: 'inclusive',
  unit_amount: unitAmount,
})

/** La suscripción del intento 1: Pro mensual de 0 días de la v2, ya cobrado; por default, con la marca del reto (3DS). */
function cobrada(metadata: Record<string, string | undefined> = {}) {
  return {
    id: 'sub_3ds',
    status: 'active',
    customer: 'cus_1',
    default_payment_method: 'pm_1',
    metadata: Object.fromEntries(
      Object.entries({
        organizationId: 'org-1',
        featureCode: 'PLAN_PRO',
        planActivationKey: 'plan-activation:org-1:1',
        primerCobroEsperadoCents: String(PRO_M_V2),
        planOfferVersion: '2',
        planOfferPrecioDe: '2',
        ...metadata,
      }).filter(([, v]) => v !== undefined),
    ),
    latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PRO_M_V2 },
    current_period_end: FIN,
    items: { data: [{ current_period_end: FIN, price: precio('price_v2_pro_m', PRO_M_V2) }] },
    discounts: [],
  }
}

/** La v3 publicada DESPUÉS del cobro: otro mensual de Pro, con un precio que Stripe no tiene en este escenario. */
const conLaV3 = () =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(
    punteroA('cv3', 3, definicionDePrueba({ ids: idsDeLaVersion('v3'), netos: { 'PRO:monthly': 89900 } })) as never,
  )

const nuevoJob = () => new AltasAMedioPagoJob({ cron: { start: jest.fn(), stop: jest.fn() } })
const cerroActiva = (organizationId = 'org-1') => filas.find(f => f.organizationId === organizationId)?.planActivationStatus === 'ACTIVE'

beforeEach(() => {
  jest.clearAllMocks()
  filas = [altaEnCurso()]
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  prismaMock.onboardingProgress.findMany.mockImplementation((async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
    filas
      .filter(f => cumple(f, where))
      .slice(0, take)
      .map(f => ({ id: f.id, organizationId: f.organizationId }))) as never)
  prismaMock.onboardingProgress.findUnique.mockImplementation((async ({ where }: { where: { organizationId: string } }) => {
    const f = filas.find(x => x.organizationId === where.organizationId)
    return f ? { ...f } : null
  }) as never)
  prismaMock.onboardingProgress.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: Record<string, unknown>
    data: Record<string, unknown>
  }) => {
    const tocadas = filas.filter(f => cumple(f, where))
    // `updatedAt` se mueve en cada escritura, como el `@updatedAt` de Prisma (así el alta recién cerrada está «reciente»).
    for (const f of tocadas) Object.assign(f, data, { updatedAt: new Date() })
    return { count: tocadas.length }
  }) as never)
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ staffId: 'owner-1' } as never)
  prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-pro',
    code: 'PLAN_PRO',
    monthlyPrice: 999,
    stripeProductId: 'prod_pro',
  } as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Negocio',
    slug: 'negocio-de-prueba',
    email: 'negocio@example.com',
    stripeCustomerId: 'cus_1',
    organization: { email: 'org@example.com', name: 'Org' },
  } as never)
  // Los clientes de Stripe de los negocios de la organización (donde se busca la llave del intento).
  prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', stripeCustomerId: 'cus_1' }] as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.planOfferPointer.findUnique
    .mockReset()
    .mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), planes: { PRO: { trialDays: 0 } } })) as never)
  mockPriceList.mockReset().mockResolvedValue({ data: [precio('price_llave', 115884)] })
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (id !== 'price_v2_pro_m') throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
    return precio('price_v2_pro_m', PRO_M_V2)
  })
  mockSubRetrieve.mockReset().mockResolvedValue(cobrada())
  mockSubList.mockReset()
  mockInvList.mockReset().mockResolvedValue({ has_more: false, data: [] })
  mockCubierto.mockReset().mockResolvedValue(true)
  mockEntregar.mockReset().mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
    venueId: 'venue-1',
    featureId: 'feat-pro',
    featureCode: 'PLAN_PRO',
    subscriptionId,
    endDate: null,
  }))
})

describe('altas-a-medio-pago con un alta estándar y una versión del editor', () => {
  it('🔴 un 3DS estándar autorizado después de publicar la v3 → { cerradas: 1, fallidas: 0 } y el alta ACTIVE', async () => {
    conLaV3()

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 1, fallidas: 0 })
    expect(cerroActiva()).toBe(true)
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
    expect(mockCubierto).toHaveBeenCalledWith('venue-1', 'sub_3ds', PRO_M_V2)
    // Ningún precio de la v3 decidió nada, y nada se cobró de nuevo.
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 b2-r2 #1: Pro de 0 días cobrado en el PRIMER create (sin primerCobroEsperadoCents), respuesta perdida, id guardado → el job lo cierra ACTIVE', async () => {
    mockSubRetrieve.mockResolvedValue(cobrada({ primerCobroEsperadoCents: undefined }))

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 1, fallidas: 0 })
    expect(cerroActiva()).toBe(true)
    // Sin la marca, la evidencia del reto no se exige (es un cobro clásico, como hoy).
    expect(mockCubierto).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 b2-r1 #1 + b2-r2 #1: lo mismo sin planStripeSubscriptionId (planOfferVersionNumber 2) → el job lo encuentra por la llave, registra el id y lo cierra', async () => {
    filas = [altaEnCurso({ planStripeSubscriptionId: null })]
    const suya = cobrada({ primerCobroEsperadoCents: undefined })
    mockSubRetrieve.mockResolvedValue(suya)
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const s of [{ id: 'sub_ajena', metadata: { planActivationKey: 'otra' } }, suya]) if ((await cb(s)) === false) return
      },
    })

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 1, fallidas: 0 })
    expect(mockSubList).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 })
    // El id se registró con el CAS del intento (sólo si seguía sin id), y el cierre lo dejó ACTIVE con él.
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', planActivationAttempt: 1, planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: null },
      data: { planStripeSubscriptionId: 'sub_3ds' },
    })
    expect(cerroActiva()).toBe(true)
    expect(filas[0].planStripeSubscriptionId).toBe('sub_3ds')
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('un intento sin versión y sin la marca no se cierra aquí (NADA, como hoy); uno sin id y sin planOfferVersionNumber no se selecciona', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(null)
    filas = [
      altaEnCurso({ planOfferVersionNumber: null }),
      altaEnCurso({ id: 'op-2', organizationId: 'org-2', planStripeSubscriptionId: null, planOfferVersionNumber: null }),
    ]
    mockSubRetrieve.mockResolvedValue(cobrada({ primerCobroEsperadoCents: undefined, planOfferVersion: undefined }))

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 0, liberadas: 0, fallidas: 0 })
    // La sin versión se lee como hoy (sin expandir la factura) y no se toca.
    expect(mockSubRetrieve.mock.calls).toEqual([['sub_3ds']])
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockSubList).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.findUnique).not.toHaveBeenCalledWith({ where: { organizationId: 'org-2' } })
  })

  it('🔴 b2-r9 #3: un 3DS de la v2 ya autorizado y versionQueCobra() lanzando → { cerradas: 1, fallidas: 0 } y el alta ACTIVE', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, { schemaVersion: 1, PRO: 'roto' }) as never)

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 1, fallidas: 0 })
    expect(cerroActiva()).toBe(true)
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

/**
 * Planes editables B2, Task 6 (b2-r3 #3): la prueba SIN tarjeta cuya respuesta del `create` se perdió, y que Stripe ya canceló
 * al terminar sin tarjeta. El barrido la encuentra por la llave del intento y cierra el alta en Gratis: no la deja esperando un
 * cobro que nunca llegará (ni un 503 eterno), y nunca crea nada en Stripe.
 */
describe('altas-a-medio-pago con una prueba sin tarjeta que ya terminó', () => {
  /** Lo que el cierre en Gratis agregó al formulario (`fusionarV2SetupData`). */
  function planDelCierre(): any {
    const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
      (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
    )
    const ultima = fusiones.at(-1)
    return ultima ? JSON.parse(ultima[1]).plan : undefined
  }

  it('🔴 b2-r3 #3: alta sin tarjeta IN_PROGRESS sin id (respuesta perdida) y la prueba ya cancelada al terminar → el job la encuentra por la llave y cierra el alta en Gratis, sin 503 ni create', async () => {
    filas = [altaEnCurso({ planStripeSubscriptionId: null })]
    const terminada = {
      ...cobrada({ primerCobroEsperadoCents: undefined, sinTarjeta: 'true' }),
      status: 'canceled',
      default_payment_method: null,
      trial_end: FIN,
      ended_at: FIN,
      latest_invoice: { id: 'in_0', status: 'paid', amount_paid: 0 },
    }
    mockSubRetrieve.mockResolvedValue(terminada)
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const s of [{ id: 'sub_ajena', metadata: { planActivationKey: 'otra' } }, terminada]) if ((await cb(s)) === false) return
      },
    })
    // Su historia: sólo la factura de $0 de la prueba.
    mockInvList.mockResolvedValue({ has_more: false, data: [{ id: 'in_0', status: 'paid', total: 0, amount_paid: 0 }] })

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 1, fallidas: 0 })
    expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_3ds', status: 'paid', limit: 100 })
    // El paso del plan quedó resuelto en Gratis: ACTIVE sin suscripción y sin lease, y el plan dice FREE.
    expect(filas[0]).toMatchObject({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: null, planActivationLeaseUntil: null })
    expect(planDelCierre()).toMatchObject({ tier: 'FREE', pruebaSinTarjetaTerminada: true, subscriptionId: 'sub_3ds', offerVersion: 2 })
    // Nada se cobró, creó ni entregó.
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockEntregar).not.toHaveBeenCalled()
  })
})
