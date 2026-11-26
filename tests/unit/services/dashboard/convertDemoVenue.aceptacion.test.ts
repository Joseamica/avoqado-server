/**
 * Planes editables B2, Task 8: la conversión de demo guarda su aceptación con el CAS.
 *
 * Con una versión del editor (la v2), `convertDemoVenue`:
 *  1. ANTES de limpiar, revisa el plan que eligió la persona (`plan`): el comprobante de «Tu plan» (alcance `venue:<id>`, la vigente),
 *     la opción de la vigente y su precio. Un rechazo no limpia nada. Sin `plan`, 409 QUOTE_REQUIRED (una demo nunca pasa a Gratis en
 *     silencio); Gratis también se dice (`{ tier: 'FREE' }`).
 *  2. limpia, como hoy; si la limpieza ve que el negocio ya no es demo (otra pestaña lo convirtió), 409 VENUE_ALREADY_CONVERTED.
 *  3. convierte con un CAS (`TRIAL` → `PENDING_ACTIVATION`) y, con un plan de pago, crea su `PlanAcceptance` en la MISMA transacción.
 *
 * Sin versión del editor (sin versiones o sólo la v1): la conversión de hoy, literal, aunque llegue `plan`.
 */
const mockCleanDemoData = jest.fn()
jest.mock('@/services/onboarding/demoCleanup.service', () => ({
  ...jest.requireActual('@/services/onboarding/demoCleanup.service'),
  cleanDemoData: (...a: unknown[]) => mockCleanDemoData(...a),
}))
jest.mock('@/services/superadmin/kycReview.service', () => ({
  notifySuperadminsNewKycSubmission: jest.fn().mockResolvedValue(undefined),
}))
// Ninguna llamada a Stripe en esta suite (sin `paymentMethodId` ni funciones sueltas): si alguna saliera, fallaría aquí.
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})))

import { VenueStatus } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import { convertDemoVenue } from '@/services/dashboard/venue.dashboard.service'
import { PLAN_ACCEPTANCE_TTL_MS } from '@/services/billing/cotizacionDeLaOferta'
import { MENSAJE_PLAN_NO_CONFIGURADO } from '@/services/billing/planOffer'
import { TIMEOUT_DE_LA_LIMPIEZA_DEMO_MS } from '@/services/onboarding/demoCleanup.service'
import type { CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import { logAction } from '@/services/dashboard/activity-log.service'
import logger from '@/config/logger'

const ORG_ID = 'clorgdemoconversion000001'
const VENUE_ID = 'clvenuedemoconversion0001'
const STAFF_ID = 'clstaffdemoconversion0001'
const PRO_M_V2 = 92684 // 79900 + IVA

const documentos = {
  entityType: 'PERSONA_FISICA' as const,
  idDocumentUrl: 'https://example.com/id.pdf',
  rfcDocumentUrl: 'https://example.com/rfc.pdf',
  comprobanteDomicilioUrl: 'https://example.com/domicilio.pdf',
  caratulaBancariaUrl: 'https://example.com/caratula.pdf',
}

type Planes = NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes']
/** La v2 del editor: Pro mensual a $799 + IVA; lo demás como hoy. */
const v2 = (planes: Planes = {}) => definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 }, planes })
const conVigente = (number: number, definition: unknown) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA(`cv${number}`, number, definition) as never)

/** Un comprobante de «Tu plan» para ESTE negocio: Pro mensual de la v2, hoy se paga el precio. */
const comprobante = (c: Partial<CotizacionFirmable> = {}, emitido?: Date) =>
  comprobanteDePrueba(
    { alcance: `venue:${VENUE_ID}`, versionNumber: 2, precioCents: PRO_M_V2, firstChargeCents: PRO_M_V2, trialEndsAt: null, ...c },
    emitido,
  )
const planPro = (quoteToken: unknown = comprobante()) => ({ tier: 'PRO', interval: 'monthly', quoteToken })

const limpiezaDeHoy = { deletedOrders: 3, deletedPayments: 2, canalesEnLineaSinTarifa: [] }
const convertido = { id: VENUE_ID, name: 'Negocio demo', slug: 'negocio-demo', status: VenueStatus.PENDING_ACTIVATION, features: [] }

/** Una transacción con su propio cliente: lo que se escribe en ella NO pasa por `prismaMock` (así se ve qué va junto). */
function transaccionAparte(opciones: { cas?: number } = {}) {
  const tx = {
    venue: {
      updateMany: jest.fn().mockResolvedValue({ count: opciones.cas ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(convertido),
    },
    planAcceptance: {
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'clacept00000000000000001', ...data })),
    },
  }
  prismaMock.$transaction.mockImplementationOnce((async (cb: (t: unknown) => unknown) => cb(tx)) as never)
  return tx
}

const convertir = (extra: Record<string, unknown> = {}) =>
  convertDemoVenue(ORG_ID, VENUE_ID, STAFF_ID, { ...documentos, ...extra } as Parameters<typeof convertDemoVenue>[3])

beforeEach(() => {
  jest.useRealTimers()
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.venue.findFirst.mockResolvedValue({
    id: VENUE_ID,
    name: 'Negocio demo',
    slug: 'negocio-demo',
    status: VenueStatus.TRIAL,
  } as never)
  prismaMock.venue.update.mockResolvedValue(convertido as never)
  prismaMock.venue.updateMany.mockReset()
  prismaMock.planAcceptance.create.mockReset()
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  mockCleanDemoData.mockReset().mockResolvedValue(limpiezaDeHoy)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('convertDemoVenue sin versión del editor: la conversión de hoy', () => {
  it.each([
    ['sin versiones', () => prismaMock.planOfferPointer.findUnique.mockResolvedValue(null)],
    ['con sólo la v1', () => conVigente(1, versionUno())],
  ])('🔴 sin versión del editor: el venue.update de hoy, sin transacción ni aceptación, aunque llegue plan (%s)', async (_n, preparar) => {
    preparar()

    for (const plan of [planPro('basura'), 'PRO', null, { tier: 'FREE' }]) {
      prismaMock.venue.update.mockClear()
      prismaMock.$transaction.mockClear()
      mockCleanDemoData.mockClear()

      const r = await convertir({ plan })

      expect(mockCleanDemoData).toHaveBeenCalledWith(VENUE_ID, STAFF_ID)
      expect(prismaMock.venue.update).toHaveBeenCalledTimes(1)
      expect(prismaMock.venue.update).toHaveBeenCalledWith({
        where: { id: VENUE_ID },
        data: expect.objectContaining({
          status: VenueStatus.PENDING_ACTIVATION,
          statusChangedBy: STAFF_ID,
          demoExpiresAt: null,
          entityType: 'PERSONA_FISICA',
          kycStatus: 'PENDING_REVIEW',
        }),
        include: { features: true },
      })
      // Nada nuevo: sin CAS, sin transacción, sin aceptación, y la respuesta de hoy.
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.planAcceptance.create).not.toHaveBeenCalled()
      expect(r).not.toHaveProperty('planAcceptance')
      expect(r).toEqual({ ...convertido, canalesEnLineaSinTarifa: [] })
    }
    expect(jest.mocked(logAction)).not.toHaveBeenCalled()
  })

  it('sin versión del editor y la limpieza ve que ya no es demo (NOT_DEMO): no borra, y la conversión sigue como hoy, sin 409', async () => {
    mockCleanDemoData.mockResolvedValue({ ...limpiezaDeHoy, deletedOrders: 0, deletedPayments: 0, skippedReason: 'NOT_DEMO' })

    const r = await convertir()

    expect(prismaMock.venue.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
    expect(r).toEqual({ ...convertido, canalesEnLineaSinTarifa: [] })
    // No se limpió nada: el aviso «se limpió» no sale (la limpieza ya avisó por qué no).
    expect(jest.mocked(logger.info)).not.toHaveBeenCalledWith(expect.stringContaining('Demo data cleaned'), expect.anything())
  })

  it('regresión · con la limpieza de hoy, el aviso «se limpió» sale como siempre', async () => {
    await convertir()

    expect(jest.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining('Demo data cleaned'), limpiezaDeHoy)
  })

  it('🔴 el puntero en una v1 rota (versionQueCobra lanza): la conversión de hoy, que nunca leyó la oferta, con un aviso y sin 503', async () => {
    conVigente(1, { schemaVersion: 1, rota: true })

    const r = await convertir({ plan: planPro() })

    expect(mockCleanDemoData).toHaveBeenCalledTimes(1)
    expect(prismaMock.venue.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.planAcceptance.create).not.toHaveBeenCalled()
    expect(r).toEqual({ ...convertido, canalesEnLineaSinTarifa: [] })
    expect(jest.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('conversión de demo'),
      expect.objectContaining({ venueId: VENUE_ID }),
    )
  })
})

describe('convertDemoVenue con la oferta del editor ilegible: falla cerrado ANTES de limpiar', () => {
  const sinConvertir = () => {
    expect(mockCleanDemoData).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.planAcceptance.create).not.toHaveBeenCalled()
  }

  it.each([
    ['la v2', 2],
    ['la v3', 3],
  ])('🔴 el puntero en %s con su definición rota → 503 PLAN_NOT_CONFIGURED y cleanDemoData no se llamó', async (_n, numero) => {
    conVigente(numero, { schemaVersion: 1, rota: true })

    for (const plan of [planPro(), { tier: 'FREE' }, undefined]) {
      await expect(convertir({ plan })).rejects.toMatchObject({
        statusCode: 503,
        code: 'PLAN_NOT_CONFIGURED',
        message: MENSAJE_PLAN_NO_CONFIGURADO,
      })
    }
    sinConvertir()
  })

  it('🔴 el puntero no se puede leer → 503 PLAN_NOT_CONFIGURED, sin limpiar ni convertir', async () => {
    prismaMock.planOfferPointer.findUnique.mockRejectedValue(new Error('sin conexión a la base'))

    await expect(convertir({ plan: planPro() })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_NOT_CONFIGURED',
      message: MENSAJE_PLAN_NO_CONFIGURADO,
    })
    sinConvertir()
  })

  it('una vigente sin número válido (no se sabe cuál rige) → 503, sin limpiar', async () => {
    const sinNumero = punteroA('cvx', 2, v2())
    ;(sinNumero.currentVersion as { number: number | null }).number = null
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(sinNumero as never)

    await expect(convertir({ plan: planPro() })).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    sinConvertir()
  })

  it('🔴 regresión · el puntero en una v1 sana: la conversión de hoy (sin leer el plan)', async () => {
    conVigente(1, versionUno())

    const r = await convertir({ plan: 'PRO' })

    expect(mockCleanDemoData).toHaveBeenCalledTimes(1)
    expect(prismaMock.venue.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(r).toEqual({ ...convertido, canalesEnLineaSinTarifa: [] })
  })
})

describe('convertDemoVenue con la v2 del editor', () => {
  beforeEach(() => {
    conVigente(2, v2())
  })

  it('🔴 con la v2: el comprobante se revisa ANTES de limpiar (comprobante de la v1 → 409 OFFER_CHANGED y cleanDemoData no se llamó)', async () => {
    await expect(convertir({ plan: planPro(comprobante({ versionNumber: 1 })) })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      message: 'La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.',
      details: { reason: 'VERSION', offerVersion: 2 },
    })

    expect(mockCleanDemoData).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
  })

  it('con el precio del comprobante distinto al de la v2 → 409 QUOTE_MISMATCH antes de limpiar; de otro negocio → 400 QUOTE_INVALID', async () => {
    await expect(convertir({ plan: planPro(comprobante({ precioCents: 115884, firstChargeCents: 115884 })) })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'QUOTE_MISMATCH', offerVersion: 2 },
    })
    await expect(convertir({ plan: planPro(comprobante({ alcance: 'venue:clotronegocio00000000001' })) })).rejects.toMatchObject({
      statusCode: 400,
      code: 'QUOTE_INVALID',
    })
    expect(mockCleanDemoData).not.toHaveBeenCalled()
  })

  it('con la v2 y plan: CAS TRIAL → PENDING_ACTIVATION y PlanAcceptance en la misma transacción, con validadoAt = la hora de la revisión y expiresAt = validadoAt + 30 min', async () => {
    const revision = new Date('2026-11-26T18:00:00.000Z')
    jest.useFakeTimers({
      now: revision,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
      ],
    })
    // La limpieza tarda 20 s: la aceptación conserva la hora en que se REVISÓ el comprobante, no la de después.
    mockCleanDemoData.mockImplementation(async () => {
      jest.setSystemTime(new Date(revision.getTime() + 20_000))
      return limpiezaDeHoy
    })
    const token = comprobante({}, new Date(revision.getTime() - 60_000))
    const tx = transaccionAparte()

    const r = await convertir({ plan: planPro(token) })

    // La conversión va por el CAS dentro de la transacción; el `venue.update` de hoy no corre.
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // Espera la fila si la limpieza de otra pestaña la tiene (hasta su timeout de 2 min), como el `update` de hoy.
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: TIMEOUT_DE_LA_LIMPIEZA_DEMO_MS + 10_000 })
    expect(TIMEOUT_DE_LA_LIMPIEZA_DEMO_MS).toBe(120_000)
    expect(tx.venue.updateMany).toHaveBeenCalledWith({
      where: { id: VENUE_ID, status: VenueStatus.TRIAL },
      data: expect.objectContaining({
        status: VenueStatus.PENDING_ACTIVATION,
        statusChangedBy: STAFF_ID,
        demoExpiresAt: null,
        kycStatus: 'PENDING_REVIEW',
        idDocumentUrl: documentos.idDocumentUrl,
      }),
    })
    expect(tx.planAcceptance.create).toHaveBeenCalledWith({
      data: {
        venueId: VENUE_ID,
        offerVersionId: 'cv2',
        tier: 'PRO',
        interval: 'monthly',
        quoteToken: token,
        validadoAt: revision,
        createdById: STAFF_ID,
        expiresAt: new Date(revision.getTime() + PLAN_ACCEPTANCE_TTL_MS),
      },
    })
    expect(PLAN_ACCEPTANCE_TTL_MS).toBe(30 * 60_000)
    expect(tx.venue.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: VENUE_ID }, include: { features: true } })
    // En ese orden: el CAS, la aceptación y la relectura con sus funciones.
    expect(tx.venue.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.planAcceptance.create.mock.invocationCallOrder[0])
    expect(tx.planAcceptance.create.mock.invocationCallOrder[0]).toBeLessThan(tx.venue.findUniqueOrThrow.mock.invocationCallOrder[0])
    // Y la limpieza, antes de la transacción.
    expect(mockCleanDemoData.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$transaction.mock.invocationCallOrder[0])
    // Lo de hoy más la aceptación.
    expect(r).toEqual({
      ...convertido,
      canalesEnLineaSinTarifa: [],
      planAcceptance: {
        id: 'clacept00000000000000001',
        expiresAt: new Date(revision.getTime() + PLAN_ACCEPTANCE_TTL_MS).toISOString(),
      },
    })
    expect(jest.mocked(logAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLAN_ACCEPTANCE_CREATED',
        entity: 'PlanAcceptance',
        entityId: 'clacept00000000000000001',
        venueId: VENUE_ID,
        staffId: STAFF_ID,
        data: expect.objectContaining({ tier: 'PRO', interval: 'monthly', offerVersion: 2 }),
      }),
    )
  })

  it('🔴 CAS perdido (otra pestaña ya convirtió) → 409 VENUE_ALREADY_CONVERTED y sin aceptación', async () => {
    const tx = transaccionAparte({ cas: 0 })

    await expect(convertir({ plan: planPro() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'VENUE_ALREADY_CONVERTED',
      message: 'Este negocio ya se convirtió en otra pestaña. Recarga la página.',
    })

    expect(tx.venue.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.planAcceptance.create).not.toHaveBeenCalled()
    expect(tx.venue.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
    expect(jest.mocked(logAction)).not.toHaveBeenCalled()
  })

  it('🔴 la limpieza ve que otra pestaña ya lo convirtió (NOT_DEMO) → 409 VENUE_ALREADY_CONVERTED sin CAS ni aceptación', async () => {
    mockCleanDemoData.mockResolvedValue({ ...limpiezaDeHoy, deletedOrders: 0, deletedPayments: 0, skippedReason: 'NOT_DEMO' })

    await expect(convertir({ plan: planPro() })).rejects.toMatchObject({ statusCode: 409, code: 'VENUE_ALREADY_CONVERTED' })

    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
    expect(prismaMock.planAcceptance.create).not.toHaveBeenCalled()
  })

  it('con la v2 y { tier: "FREE" }: el mismo CAS, sin aceptación; sin plan → 409 OFFER_CHANGED reason QUOTE_REQUIRED y no se limpia ni se convierte', async () => {
    const tx = transaccionAparte()

    const gratis = await convertir({ plan: { tier: 'FREE' } })

    expect(tx.venue.updateMany).toHaveBeenCalledWith({
      where: { id: VENUE_ID, status: VenueStatus.TRIAL },
      data: expect.objectContaining({ status: VenueStatus.PENDING_ACTIVATION }),
    })
    expect(tx.planAcceptance.create).not.toHaveBeenCalled()
    expect(gratis).toEqual({ ...convertido, canalesEnLineaSinTarifa: [] })
    expect(gratis).not.toHaveProperty('planAcceptance')
    expect(mockCleanDemoData).toHaveBeenCalledTimes(1)

    for (const sinPlan of [{}, { plan: null }]) {
      mockCleanDemoData.mockClear()
      prismaMock.$transaction.mockClear()

      await expect(convertir(sinPlan)).rejects.toMatchObject({
        statusCode: 409,
        code: 'OFFER_CHANGED',
        details: { reason: 'QUOTE_REQUIRED', offerVersion: 2 },
      })

      expect(mockCleanDemoData).not.toHaveBeenCalled()
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.venue.update).not.toHaveBeenCalled()
    }
  })

  it('con la v2 y un plan de pago sin comprobante → 409 QUOTE_REQUIRED antes de limpiar', async () => {
    await expect(convertir({ plan: { tier: 'PRO', interval: 'monthly' } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'QUOTE_REQUIRED', offerVersion: 2 },
    })
    expect(mockCleanDemoData).not.toHaveBeenCalled()
  })

  it.each([
    ['{ tier: "PRO" } sin periodicidad', { tier: 'PRO', quoteToken: 'x' }],
    ['un texto', 'PRO'],
    ['un tier desconocido', { tier: 'BASICO' }],
    ['Gratis con campos de más', { tier: 'FREE', interval: 'monthly' }],
    ['una periodicidad desconocida', { tier: 'PREMIUM', interval: 'weekly', quoteToken: 'x' }],
  ])('con la v2 y plan %s → 400 PLAN_INVALID antes de limpiar', async (_n, plan) => {
    await expect(convertir({ plan })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PLAN_INVALID',
      message: 'El plan elegido no es válido. Recarga la página.',
    })
    expect(mockCleanDemoData).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('plan fuera de venta → 409 PLAN_NOT_ON_SALE antes de limpiar', async () => {
    conVigente(2, v2({ PRO: { onSale: false } }))

    await expect(convertir({ plan: planPro() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_NOT_ON_SALE',
      message: 'El plan Pro ya no está a la venta. Elige otro plan. No se te cobró nada.',
      details: { tier: 'PRO' },
    })
    expect(mockCleanDemoData).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('regresión · un negocio que no es demo → el 400 de hoy, sin leer el plan', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE_ID, name: 'Negocio', slug: 'negocio', status: VenueStatus.ACTIVE } as never)

    await expect(convertir({ plan: 'PRO' })).rejects.toMatchObject({ statusCode: 400, message: 'This venue is not in demo mode' })
    expect(mockCleanDemoData).not.toHaveBeenCalled()
  })
})
