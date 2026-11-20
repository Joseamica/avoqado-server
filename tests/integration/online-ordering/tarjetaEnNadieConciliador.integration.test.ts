// tests/integration/online-ordering/tarjetaEnNadieConciliador.integration.test.ts
/**
 * Integration (REAL DB) — D661 tarea 3C: el conciliador y sus caídas. Lo que los simulacros no prueban: la decisión de volver a cobrar un
 * `CAPTURING` tomada bajo el candado REAL de la orden con el reloj real, el CAS de cada escritor cuando una captura en vuelo y una
 * liberación compiten, y que cada corte deje la base en un estado que la siguiente pasada (una llamada nueva, «tras reiniciar») termina
 * sola. Stripe es un doble con su estado por PaymentIntent (nunca el de verdad): una captura y una liberación compiten como en Stripe.
 * «Morir» = el paso anterior ya se confirmó en la base y el siguiente lanza; después corre la siguiente pasada desde cero.
 */
import { Prisma } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { reconcileCardCharges } from '@/services/online-ordering/card/reconcile.service'
import * as cobro from '@/services/online-ordering/card/capture.service'
import { cerrarFoliosDelDiaTerminado, listFolios } from '@/services/online-ordering/folios.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { getTrackingByToken } from '@/services/online-ordering/order.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { acceptOnlineOrder } from '@/services/online-ordering/transitions.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'

// El guardia global rechaza `av-db-25` y hosts remotos; esta suite exige además una base desechable o la propia de la fase.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(avoqado_[a-z0-9_]+_test_[a-z0-9_]+|av-db-25-[a-z0-9-]+)$/.test(database.pathname)
) {
  throw new Error('Esta suite sólo corre contra una base desechable (avoqado_<tarea>_test_<fecha> o av-db-25-<fase>) en localhost.')
}

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
// Hay cocina que marcar: el cobro deja la comanda pendiente (`kitchenPendingAt`) en la escritura que acepta.
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn(async () => true),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))
// El premio que regresa despierta el pase de Wallet de la clienta (fuera de la prueba).
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn(async () => ({ notified: 0 })),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))

const RUN = Date.now()
const MIN = 60_000
const TZ = 'America/Mexico_City'
const PUEDE_CREAR = { assertCanCreate: async () => {} }
const NO_FINALES = ['PENDING_AUTH', 'AUTHORIZED', 'CAPTURING', 'RELEASING'] as const
const hace = (ms: number) => new Date(Date.now() - ms)
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))
const hastaQue = async (listo: () => Promise<boolean>, ms = 5_000) => {
  const fin = Date.now() + ms
  while (!(await listo()) && Date.now() < fin) await dormir(25)
}

type EstadoPi = 'requires_capture' | 'succeeded' | 'canceled'

describe('D661 · 3C: el conciliador y sus caídas (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let productId: string
  const clientas: string[] = []
  let turno = 0
  const siguienteClienta = () => clientas[turno++ % clientas.length]
  let seq = 0
  const llave = () => `concil-${RUN}-${++seq}-`.padEnd(40, 'x')

  // ── Stripe doble, con su estado por PaymentIntent ──
  const sesiones = new Map<string, { id: string; url: string; expiresAt: Date }>()
  /** Sesión de pago → el PaymentIntent que la clienta autorizó en ella (sin entrada: todavía no paga). */
  const pagos = new Map<string, string>()
  const pis = new Map<string, EstadoPi>()
  /** La hora en que Stripe autorizó cada PaymentIntent (Ruling 10). */
  const autorizadoEn = new Map<string, Date>()
  let piSeq = 0
  let checkoutSpy: jest.SpyInstance
  let authSpy: jest.SpyInstance
  let captureSpy: jest.SpyInstance
  let voidSpy: jest.SpyInstance

  const leerPi = (pi: string) => {
    const s = pis.get(pi) ?? 'requires_capture'
    return {
      sessionStatus: 'complete',
      paymentIntentId: pi,
      piStatus: s,
      amountCapturableCents: s === 'requires_capture' ? 25_000 : 0,
      amountReceivedCents: s === 'succeeded' ? 25_000 : 0,
      captureBefore: new Date(Date.now() + 7 * 24 * 60 * MIN),
      card: { brand: 'visa', last4: '4242', funding: 'credit' },
      paymentMethodType: 'card',
      authorizedAt: autorizadoEn.get(pi),
    }
  }
  const leerSesion = (cs: string) => {
    const pi = pagos.get(cs)
    if (pi) return leerPi(pi)
    return {
      sessionStatus: 'open',
      paymentIntentId: null,
      piStatus: null,
      amountCapturableCents: 0,
      amountReceivedCents: 0,
      captureBefore: null,
      card: null,
      paymentMethodType: null,
    }
  }
  const errorDeStripe = (message: string, code: string) =>
    Object.assign(new Error(message), { type: 'StripeInvalidRequestError', code, statusCode: 400 })
  /** El proceso murió: Stripe nunca recibió la petición (o su respuesta nunca llegó a nadie). */
  const murio = () => Object.assign(new Error('el proceso murió'), { type: 'StripeConnectionError' })
  const perdida = () => Object.assign(new Error('se perdió la respuesta'), { type: 'StripeConnectionError' })

  /** La clienta paga la sesión de su borrador: Stripe aparta la tarjeta a la hora `authorizedAt`. */
  const pagar = async (chargeId: string, authorizedAt: Date) => {
    const c = await cargo(chargeId)
    const pi = `pi_concil_${RUN}_${++piSeq}`
    pagos.set(c.checkoutSessionId!, pi)
    pis.set(pi, 'requires_capture')
    autorizadoEn.set(pi, authorizedAt)
    return pi
  }

  /** El borrador de «Nadie» de una clienta con sesión (sin teléfono probado). */
  const borrador = async () => {
    const d = await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-concil-${RUN}`,
        idempotencyKey: llave(),
        items: [{ productId, quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'Ana Nadie', email: 'ana@test.com' },
        customerId: siguienteClienta(),
        verifiedPhone: null,
      },
      PUEDE_CREAR,
    )
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { trackingToken: d.trackingToken } })
    return { chargeId: c.id, trackingToken: d.trackingToken }
  }
  /** Un borrador de «Mi equipo» (con teléfono), creado con la tienda en «Mi equipo»; después la tienda regresa a «Nadie». */
  const borradorMiEquipo = async () => {
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { requiresAcceptance: true, acceptsCardOnline: true },
    })
    const d = await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-concil-${RUN}`,
        idempotencyKey: llave(),
        items: [{ productId, quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'Eva Equipo', phone: `55 1234 ${String(1000 + (seq % 9000))}` },
        customerId: null,
        verifiedPhone: null,
      },
      PUEDE_CREAR,
    )
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { requiresAcceptance: false, acceptsCardOnline: false },
    })
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { trackingToken: d.trackingToken } })
    return { chargeId: c.id, trackingToken: d.trackingToken }
  }
  const cargo = (id: string) => prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id } })
  const enLinea = (orderId: string) => prisma.onlineOrder.findFirstOrThrow({ where: { orderId } })
  const cuenta = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const cobros = (orderId: string) => prisma.payment.findMany({ where: { orderId }, take: 10 })

  /** Un apartado (pedido «Nadie» o «Mi equipo» con la tarjeta AUTHORIZED); Stripe autorizó hace `haceMs`. */
  const apartado = async (o: { miEquipo?: boolean; haceMs?: number } = {}) => {
    const d = o.miEquipo ? await borradorMiEquipo() : await borrador()
    const pi = await pagar(d.chargeId, hace(o.haceMs ?? MIN))
    await expect(confirmCardAuthorization(d.chargeId)).resolves.toBe('CREATED')
    const c = await cargo(d.chargeId)
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c.onlineOrderId! } })
    return { chargeId: c.id, orderId: oo.orderId, onlineOrderId: oo.id, trackingToken: d.trackingToken, pi }
  }
  type Apartado = Awaited<ReturnType<typeof apartado>>
  /** La caja abre el pedido (= lo cobra): «Nadie», con la apertura explícita de la caja; «Mi equipo», como siempre. */
  const abrir = (a: Pick<Apartado, 'orderId'>, miEquipo = false) =>
    acceptOnlineOrder({ venueId: venueId!, orderId: a.orderId, staffId: null, ...(miEquipo ? {} : { abrirPagadoEnLinea: true as const }) })
  /**
   * La caja abre, el cargo se guarda `CAPTURING` y el proceso muere antes de que Stripe reciba la captura (la relectura tampoco
   * llega): la tarjeta sigue apartada en Stripe y nada más se escribió en el pedido.
   */
  const muereAntesDeStripe = async (a: Apartado, miEquipo = false) => {
    captureSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    authSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    await expect(abrir(a, miEquipo)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect((await cargo(a.chargeId)).status).toBe('CAPTURING')
    expect(pis.get(a.pi)).toBe('requires_capture')
  }
  /** La caja abre, Stripe SÍ cobra y el proceso muere antes de anotarlo (ni la respuesta ni la relectura llegan). */
  const muereDespuesDeQueStripeCobro = async (a: Apartado, miEquipo = false) => {
    captureSpy.mockImplementationOnce(async (_m: any, p: any) => {
      pis.set(p.paymentIntentId, 'succeeded')
      throw murio()
    })
    authSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    await expect(abrir(a, miEquipo)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect((await cargo(a.chargeId)).status).toBe('CAPTURING')
    expect(pis.get(a.pi)).toBe('succeeded')
  }
  /** El plazo del apartado quedó `ms` atrás (la gracia es de 5 min). */
  const plazoHace = (a: Apartado, ms: number) =>
    prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { acceptDeadlineAt: hace(ms) } })
  /** La siguiente pasada del conciliador (cada minuto): el cargo en duda ya tiene más de 60 s sin tocarse. */
  const pasada = async (...ids: string[]) => {
    if (ids.length) await prisma.onlineOrderCharge.updateMany({ where: { id: { in: ids } }, data: { updatedAt: hace(2 * MIN) } })
    return reconcileCardCharges(new Date(), read => read())
  }
  const capturasA = (pi: string) => captureSpy.mock.calls.filter(([, p]) => p.paymentIntentId === pi)
  const liberacionesA = (pi: string) => voidSpy.mock.calls.filter(([, p]) => p.paymentIntentId === pi)
  /** Sostiene un candado en otra transacción `ms` milisegundos; `listo` cuando ya lo tiene. */
  const sostener = (tomar: (tx: any) => Promise<unknown>, ms: number) => {
    let avisar!: () => void
    const listo = new Promise<void>(r => (avisar = r))
    const hecho = prisma.$transaction(
      async tx => {
        await tomar(tx)
        avisar()
        await dormir(ms)
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    return { listo, hecho }
  }
  /** Un premio de sellos canjeado en la cuenta del pedido (así lo deja un canje: fila de descuento + premio REDEEMED ligado). */
  const conPremio = async (orderId: string) => {
    const customerId = (await cuenta(orderId)).customerId ?? siguienteClienta()
    const card = await prisma.stampCard.create({
      data: { customerId, venueId: venueId!, cycle: 1, stampsRequired: 7, stampsEarned: 7, completedAt: new Date() },
    })
    const fila = await prisma.orderDiscount.create({
      data: { orderId, type: 'FIXED_AMOUNT', name: 'premio', value: 85, amount: 85, taxReduction: new Prisma.Decimal('11.72') },
    })
    const premio = await prisma.stampReward.create({
      data: {
        stampCardId: card.id,
        customerId,
        venueId: venueId!,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 85,
        rewardLabel: 'Combo gratis',
        status: 'REDEEMED',
        redeemedAt: new Date(),
        orderDiscountId: fila.id,
      },
    })
    return premio.id
  }
  /** La cuenta se paga por otro camino (lo que deja la TPV al registrar dinero ya movido; ver tarjetaEnNadieAbrir). */
  const pagadaPorOtroCamino = async (orderId: string) => {
    await prisma.payment.create({
      data: {
        venueId: venueId!,
        orderId,
        amount: 250,
        method: 'CASH',
        source: 'TPV',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 250,
      },
    })
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID', paidAmount: 250, remainingBalance: 0 } })
  }
  const anomaliasDeCobroExterno = (chargeId: string) =>
    prisma.moneyAnomaly.count({
      where: { category: 'ONLINE_ORDER_CARD_CAPTURED_OUTSIDE', expectedState: { path: ['chargeId'], equals: chargeId } },
    })
  /** El pedido quedó cobrado por NOSOTROS: un pago, aceptado y con la comanda pendiente; nunca como captura externa. */
  const cobradoUnaVez = async (a: Apartado) => {
    const c = await cargo(a.chargeId)
    expect(c.status).toBe('CAPTURED')
    expect(c.lastError).toBeNull()
    expect(await cobros(a.orderId)).toHaveLength(1)
    const oo = await enLinea(a.orderId)
    expect(oo.status).toBe('ACCEPTED')
    const order = await cuenta(a.orderId)
    expect(order).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' })
    expect(order.kitchenPendingAt).toEqual(oo.acceptedAt)
    expect(await anomaliasDeCobroExterno(a.chargeId)).toBe(0)
    return oo
  }
  /** Ganó la liberación: pedido rechazado por el cobro, cargo cerrado sin cobrar, ningún pago. */
  const cerradoSinCobrar = async (a: Apartado) => {
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    expect((await cuenta(a.orderId)).status).toBe('CANCELLED')
    expect((await cargo(a.chargeId)).status).toBe('CAPTURE_FAILED')
    expect(await cobros(a.orderId)).toHaveLength(0)
    expect(pis.get(a.pi)).toBe('canceled')
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Concil Org', slug: `itest-concil-org-${RUN}`, email: `itest-concil-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Concil Venue',
        slug: `itest-concil-${RUN}`,
        organizationId: org.id,
        timezone: TZ,
        address: 'Av. Coyoacán 123',
        city: 'CDMX',
        state: 'CDMX',
        zipCode: '04000',
        phone: '5512345678',
      },
    })
    venueId = venue.id
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-concil-${RUN}` } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-concil-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `CONCIL-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    for (let i = 0; i < 25; i++) {
      clientas.push(
        (await prisma.customer.create({ data: { venueId, email: `concil${i}-${RUN}@test.com`, firstName: `Clienta ${i}` } })).id,
      )
    }
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: 'ITEST Concil',
        contactEmail: `itest-concil-merchant-${RUN}@test.com`,
        publicKey: `pk_test_itest_concil_${RUN}`,
        secretKeyHash: `itest-concil-hash-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: 'acct_itest_concil' },
        chargesEnabled: true,
        platformFeeBps: 100,
        sandboxMode: true,
      },
    })
    await updateSettings(venueId, { enabled: true, minOrderAmount: 0, defaultPrepMinutes: 15 }, null)
    clearPublicMenuCache()
    checkoutSpy = jest.spyOn(StripeConnectProvider.prototype, 'createAuthorizationCheckout')
    authSpy = jest.spyOn(StripeConnectProvider.prototype, 'getAuthorization')
    captureSpy = jest.spyOn(StripeConnectProvider.prototype, 'capture')
    voidSpy = jest.spyOn(StripeConnectProvider.prototype, 'voidAuthorization')
  })

  beforeEach(async () => {
    checkoutSpy.mockReset()
    checkoutSpy.mockImplementation(async (_m: any, p: any) => {
      if (!sesiones.has(p.idempotencyKey)) {
        const id = `cs_itest_concil_${RUN}_${sesiones.size + 1}`
        sesiones.set(p.idempotencyKey, { id, url: `https://checkout.stripe.test/${id}`, expiresAt: p.expiresAt })
      }
      return sesiones.get(p.idempotencyKey)!
    })
    authSpy.mockReset()
    authSpy.mockImplementation(async (_m: any, ref: any) =>
      ref.paymentIntentId ? leerPi(ref.paymentIntentId) : leerSesion(ref.checkoutSessionId),
    )
    // Stripe cobra lo apartado; un PaymentIntent ya soltado no se cobra.
    captureSpy.mockReset()
    captureSpy.mockImplementation(async (_m: any, p: any) => {
      if (pis.get(p.paymentIntentId) === 'canceled')
        throw errorDeStripe('This PaymentIntent has a status of canceled.', 'payment_intent_unexpected_state')
      pis.set(p.paymentIntentId, 'succeeded')
      return leerPi(p.paymentIntentId)
    })
    // Stripe suelta lo apartado; uno ya cobrado no se suelta.
    voidSpy.mockReset()
    voidSpy.mockImplementation(async (_m: any, p: any) => {
      if (pis.get(p.paymentIntentId) === 'succeeded') {
        throw errorDeStripe(
          'This PaymentIntent could not be canceled because it has a status of succeeded.',
          'payment_intent_unexpected_state',
        )
      }
      pis.set(p.paymentIntentId, 'canceled')
      return leerPi(p.paymentIntentId)
    })
    ;(logAction as jest.Mock).mockClear()
    // El conciliador lee TODOS los cargos de la base (la desechable de este proceso): lo de pruebas anteriores queda resuelto.
    await prisma.onlineOrderCharge.updateMany({ where: { status: { in: [...NO_FINALES] } }, data: { status: 'ABANDONED' } })
    await prisma.onlineOrder.updateMany({ where: { venueId: venueId!, status: 'PENDING_ACCEPTANCE' }, data: { status: 'EXPIRED' } })
    const ahora = new Date()
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: {
        enabled: true,
        requiresAcceptance: false,
        cardOnlineNadie: true,
        acceptsCardOnline: false,
        acceptsPayAtPickup: true,
        hours: Prisma.DbNull,
        lastToPayPollAt: ahora,
        lastCardAlertPollAt: ahora,
        cardAlertFastPollAt: ahora,
        lastInboxPollAt: ahora,
      },
    })
  })

  afterAll(async () => {
    for (const s of [checkoutSpy, authSpy, captureSpy, voidSpy]) s?.mockRestore()
    // Limpieza acotada: sin venueId NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!venueId) return
    const v = { venueId }
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
    await prisma.moneyAnomaly.deleteMany({ where: { expectedState: { path: ['venueId'], equals: venueId } } })
    await prisma.activityLog.deleteMany({ where: v })
    await prisma.walletPassOutbox.deleteMany({ where: v })
    await prisma.paymentEffect.deleteMany({ where: v })
    await prisma.inventoryPosting.deleteMany({ where: v })
    await prisma.venueTransaction.deleteMany({ where: v })
    await prisma.payment.deleteMany({ where: v })
    await prisma.onlineOrderCharge.deleteMany({ where: v }) // antes del comercio (Restrict)
    await prisma.onlineOrder.deleteMany({ where: v })
    await prisma.stampReward.deleteMany({ where: v })
    await prisma.order.deleteMany({ where: v })
    await prisma.stampCard.deleteMany({ where: v })
    await prisma.ecommerceMerchant.deleteMany({ where: v })
    await prisma.product.deleteMany({ where: v })
    await prisma.menuCategory.deleteMany({ where: v })
    await prisma.customer.deleteMany({ where: v })
    await prisma.onlineOrderingSettings.deleteMany({ where: v })
    await prisma.privacyNoticeVersion.deleteMany({ where: v })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  // ── r4 #2: el reintento de un CAPTURING de más de 60 s ──────────────────────────────────────────────────────────────────────

  it('el reconciliador conserva el reintento de un CAPTURING (> 60 s) como hoy en «Mi equipo»', async () => {
    const a = await apartado({ miEquipo: true })
    expect((await enLinea(a.orderId)).requiresAcceptance).toBe(true)
    await muereAntesDeStripe(a, true)
    // «Mi equipo» no tiene gracia: aunque su plazo pasó hace una hora, la persona lo aceptó a tiempo y se cobra.
    await plazoHace(a, 60 * MIN)

    // Ruling 2: con menos de 60 s puede haber una captura en vuelo: no se toca.
    await prisma.onlineOrderCharge.update({ where: { id: a.chargeId }, data: { updatedAt: hace(20_000) } })
    authSpy.mockClear()
    await expect(reconcileCardCharges(new Date(), read => read())).resolves.toMatchObject({ scanned: 0 })
    expect(authSpy).not.toHaveBeenCalled()

    await expect(pasada(a.chargeId)).resolves.toMatchObject({ scanned: 1, finished: 1, errors: 0 })
    const [primera, reintento] = capturasA(a.pi)
    expect(reintento[1]).toEqual(primera[1]) // la MISMA clave y los mismos parámetros
    expect(reintento[1].idempotencyKey).toBe(`online-order:${a.orderId}:capture`)
    expect(liberacionesA(a.pi)).toHaveLength(0)
    await cobradoUnaVez(a)
  })

  it('muere entre guardar CAPTURING y llamar a Stripe → el reintento cobra o, si Stripe sigue en requires_capture y el intento se abandona, libera y cierra sólo con el resultado de Stripe', async () => {
    // Dentro de la gracia (el plazo pasó hace 2 min; la caja lo abrió a tiempo): el reintento cobra, como en «Mi equipo».
    const dentro = await apartado()
    await muereAntesDeStripe(dentro)
    await plazoHace(dentro, 2 * MIN)
    await expect(pasada(dentro.chargeId)).resolves.toMatchObject({ scanned: 1, finished: 1 })
    expect(capturasA(dentro.pi)).toHaveLength(2)
    await cobradoUnaVez(dentro)

    // Pasada la gracia: ya no se cobra. Se pide soltarla; Stripe la suelta pero la respuesta (y la relectura) se pierden.
    const fuera = await apartado()
    await muereAntesDeStripe(fuera)
    await plazoHace(fuera, 6 * MIN)
    voidSpy.mockImplementationOnce(async (_m: any, p: any) => {
      pis.set(p.paymentIntentId, 'canceled')
      throw perdida()
    })
    authSpy
      .mockImplementationOnce(async (_m: any, ref: any) => leerPi(ref.paymentIntentId))
      .mockImplementationOnce(async () => {
        throw perdida()
      })
    await pasada(fuera.chargeId)
    // Sin el desenlace de Stripe nada se cierra: el pedido sigue por abrir y el cargo en duda (la caja ve «cobrando»).
    expect(await enLinea(fuera.orderId)).toMatchObject({ status: 'PENDING_ACCEPTANCE' })
    expect((await cargo(fuera.chargeId)).status).toBe('CAPTURING')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pasó la gracia'),
      expect.objectContaining({ chargeId: fuera.chargeId }),
    )
    expect((await listFolios({ venueId: venueId! })).tarjetasPorAbrir).toContainEqual(
      expect.objectContaining({ orderId: fuera.orderId, cobrando: true }),
    )

    // La siguiente pasada relee a Stripe: la soltó → se cierra con ese desenlace. Nunca se volvió a mandar la captura.
    await pasada(fuera.chargeId)
    await cerradoSinCobrar(fuera)
    expect(capturasA(fuera.pi)).toHaveLength(1) // sólo la de la caja (que nunca llegó)
    expect(liberacionesA(fuera.pi)[0][1]).toEqual({ paymentIntentId: fuera.pi, idempotencyKey: `online-order:${fuera.orderId}:release` })
    expect(await getTrackingByToken(fuera.trackingToken)).toMatchObject({ status: 'REJECTED', paid: false })
  })

  it('muere después de que Stripe cobró y antes de anotarlo → el reintento lo anota', async () => {
    for (const miEquipo of [true, false]) {
      const a = await apartado({ miEquipo })
      await muereDespuesDeQueStripeCobro(a, miEquipo)
      expect(await cobros(a.orderId)).toHaveLength(0)
      await expect(pasada(a.chargeId)).resolves.toMatchObject({ scanned: 1, finished: 1, errors: 0 })
      expect({ miEquipo, capturas: capturasA(a.pi).length }).toEqual({ miEquipo, capturas: 1 }) // no se vuelve a cobrar
      await cobradoUnaVez(a)
      // Una pasada más no duplica nada.
      await pasada(a.chargeId)
      expect(await cobros(a.orderId)).toHaveLength(1)
    }
  })

  // ── r5 #1: el reintento de un CAPTURING de «Nadie» ya vencido ───────────────────────────────────────────────────────────────

  it('reintento de un CAPTURING de «Nadie» ya vencido (acceptDeadlineAt + 5 min de gracia): bajo el candado concilia con Stripe; si ya cobró, lo anota (el pedido sigue: la cajera lo abrió a tiempo); si sigue apartado, libera y cierra sólo con el desenlace de Stripe', async () => {
    // Pasada la gracia y Stripe ya cobró: se anota, el pedido sigue (aceptado y con su comanda).
    const cobrada = await apartado()
    await muereDespuesDeQueStripeCobro(cobrada)
    await plazoHace(cobrada, 30 * MIN)
    await expect(pasada(cobrada.chargeId)).resolves.toMatchObject({ finished: 1 })
    expect(liberacionesA(cobrada.pi)).toHaveLength(0)
    expect(capturasA(cobrada.pi)).toHaveLength(1)
    await cobradoUnaVez(cobrada)

    // Pasada la gracia y sigue apartada: se suelta y se cierra con el desenlace de Stripe; ninguna captura nueva.
    const apartada = await apartado()
    await muereAntesDeStripe(apartada)
    await plazoHace(apartada, 6 * MIN)
    await expect(pasada(apartada.chargeId)).resolves.toMatchObject({ finished: 1 })
    expect(capturasA(apartada.pi)).toHaveLength(1)
    await cerradoSinCobrar(apartada)

    // Bajo el candado y con el reloj real: la gracia vence mientras otra transacción sostiene la orden. La pasada empezó dentro de la
    // gracia, pero decide después del candado: ya no cobra.
    const cruza = await apartado()
    await muereAntesDeStripe(cruza)
    await prisma.onlineOrder.update({ where: { id: cruza.onlineOrderId }, data: { acceptDeadlineAt: hace(5 * MIN - 1500) } })
    await prisma.onlineOrderCharge.update({ where: { id: cruza.chargeId }, data: { updatedAt: hace(2 * MIN) } })
    const orden = sostener(tx => lockExistingOrderForPayment(tx, { venueId: venueId!, orderId: cruza.orderId }), 2500)
    await orden.listo
    const laPasada = reconcileCardCharges(new Date(), read => read())
    await orden.hecho
    await laPasada
    expect(capturasA(cruza.pi)).toHaveLength(1)
    await cerradoSinCobrar(cruza)
  })

  // ── r6 #1: liberar un cobro en duda, con sus dos cortes ─────────────────────────────────────────────────────────────────────

  it('D661 · r6 #1: si gana la liberación de un cobro en duda (cortes después de decidir y después de la respuesta de Stripe), el pedido se cierra y regresan sus canjes; ningún reintento cobra después de la gracia', async () => {
    const a = await apartado()
    const premioId = await conPremio(a.orderId)
    await muereAntesDeStripe(a)
    await plazoHace(a, 6 * MIN)

    // (a) Ya decidido liberar, el proceso muere antes de que Stripe reciba la liberación (y la relectura).
    voidSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    authSpy
      .mockImplementationOnce(async (_m: any, ref: any) => leerPi(ref.paymentIntentId))
      .mockImplementationOnce(async () => {
        throw murio()
      })
    await pasada(a.chargeId)
    expect(pis.get(a.pi)).toBe('requires_capture')
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'PENDING_ACCEPTANCE' })
    expect((await cargo(a.chargeId)).status).toBe('CAPTURING')
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: premioId } })).toMatchObject({ status: 'REDEEMED' })

    // (b) Tras reiniciar, Stripe la suelta y contesta, pero el proceso muere antes de anotarlo.
    const anotar = jest.spyOn(cobro, 'failCapture').mockImplementationOnce(async () => {
      throw murio()
    })
    try {
      await pasada(a.chargeId)
    } finally {
      anotar.mockRestore()
    }
    expect(pis.get(a.pi)).toBe('canceled')
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'PENDING_ACCEPTANCE' })
    expect((await cargo(a.chargeId)).status).toBe('CAPTURING')

    // Tras reiniciar otra vez: Stripe dice que la soltó → el pedido se cierra y el premio regresa a la clienta.
    await expect(pasada(a.chargeId)).resolves.toMatchObject({ scanned: 1, finished: 1, errors: 0 })
    await cerradoSinCobrar(a)
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: premioId } })).toMatchObject({
      status: 'PENDING',
      orderDiscountId: null,
      redeemedAt: null,
    })
    expect(capturasA(a.pi)).toHaveLength(1) // sólo la de la caja: ningún reintento cobró después de la gracia
    // Una caja que lo abre después no lo cobra.
    await expect(abrir(a)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(capturasA(a.pi)).toHaveLength(1)
  })

  it('D661 · r6 #1: si gana el cobro que seguía en vuelo (cortes después de decidir liberar y después de la respuesta de Stripe), hay UN solo pago, el pedido queda aceptado con su comanda pendiente y nunca se anota como captura externa', async () => {
    for (const corte of ['después de decidir', 'después de la respuesta'] as const) {
      const a = await apartado()
      // La caja abre a tiempo y su captura se queda en vuelo (Stripe la aplica después; su respuesta tarda más).
      let entro!: () => void
      const entroACobrar = new Promise<void>(r => (entro = r))
      let responder!: () => void
      const respuesta = new Promise<void>(r => (responder = r))
      captureSpy.mockImplementationOnce(async (_m: any, p: any) => {
        entro()
        await respuesta
        return leerPi(p.paymentIntentId)
      })
      const laCaja = abrir(a)
      await entroACobrar
      await plazoHace(a, 6 * MIN)

      if (corte === 'después de decidir') {
        // La pasada lee «apartada», decide liberar; la captura en vuelo llega a Stripe y el proceso muere antes de su liberación.
        voidSpy.mockImplementationOnce(async () => {
          pis.set(a.pi, 'succeeded')
          throw murio()
        })
        authSpy
          .mockImplementationOnce(async (_m: any, ref: any) => leerPi(ref.paymentIntentId))
          .mockImplementationOnce(async () => {
            throw murio()
          })
        await pasada(a.chargeId)
      } else {
        // Stripe contesta la liberación «ya está cobrada» (la captura llegó primero) y el proceso muere antes de anotar el cobro.
        voidSpy.mockImplementationOnce(async () => {
          pis.set(a.pi, 'succeeded')
          throw errorDeStripe(
            'This PaymentIntent could not be canceled because it has a status of succeeded.',
            'payment_intent_unexpected_state',
          )
        })
        const anotar = jest.spyOn(cobro, 'finishCapture').mockImplementationOnce(async () => {
          throw murio()
        })
        try {
          await pasada(a.chargeId)
        } finally {
          anotar.mockRestore()
        }
      }
      expect({ corte, cobros: (await cobros(a.orderId)).length }).toEqual({ corte, cobros: 0 })
      expect({ corte, pedido: (await enLinea(a.orderId)).status }).toEqual({ corte, pedido: 'PENDING_ACCEPTANCE' })
      expect({ corte, cargo: (await cargo(a.chargeId)).status }).toEqual({ corte, cargo: 'CAPTURING' })

      // Tras reiniciar: Stripe dice que cobró. Fue NUESTRA captura: se anota como cualquier cobro.
      await expect(pasada(a.chargeId)).resolves.toMatchObject({ scanned: 1, finished: 1, errors: 0 })
      await cobradoUnaVez(a)
      expect({ corte, capturas: capturasA(a.pi).length }).toEqual({ corte, capturas: 1 }) // ningún reintento cobró

      // La respuesta de la caja llega al fin: el cobro ya estaba anotado; un solo pago.
      responder()
      await expect(laCaja).resolves.toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
      expect(await cobros(a.orderId)).toHaveLength(1)
    }
  })

  // ── Ruling 10: la autorización que nadie avisó ──────────────────────────────────────────────────────────────────────────────

  it('D661 · Ruling 10: el conciliador visita desde los 2 min los borradores de «Nadie» (sin esperar a que venza su página): recupera a tiempo una autorización sin aviso ni pestaña y libera la que descubre tarde, sin preguntar de más a Stripe', async () => {
    const borradorDeHace = async (ms: number, miEquipo = false) => {
      const d = miEquipo ? await borradorMiEquipo() : await borrador()
      await prisma.onlineOrderCharge.update({ where: { id: d.chargeId }, data: { createdAt: hace(ms) } })
      return d
    }
    const atiempo = await borradorDeHace(3 * MIN) // autorizó hace 1 min, nadie avisó
    await pagar(atiempo.chargeId, hace(MIN))
    const tarde = await borradorDeHace(15 * MIN) // autorizó hace 11 min: se supo después de su plazo
    const piTarde = await pagar(tarde.chargeId, hace(11 * MIN))
    const sinPagar = await borradorDeHace(5 * MIN) // todavía pagando
    const joven = await borradorDeHace(30_000) // de menos de 2 min: no se visita todavía
    await pagar(joven.chargeId, hace(10_000))
    const miEquipo = await borradorDeHace(5 * MIN, true) // «Mi equipo»: se visita como hoy, al vencer su página
    await pagar(miEquipo.chargeId, hace(MIN))
    authSpy.mockClear()

    await reconcileCardCharges(new Date(), read => read())

    // A tiempo: nace el pedido abrible, con el plazo desde la hora de Stripe; la caja lo ve.
    const c1 = await cargo(atiempo.chargeId)
    expect(c1.status).toBe('AUTHORIZED')
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c1.onlineOrderId! } })
    expect(oo).toMatchObject({ status: 'PENDING_ACCEPTANCE', requiresAcceptance: false })
    expect(oo.acceptDeadlineAt).toEqual(new Date(autorizadoEn.get(pagos.get(c1.checkoutSessionId!)!)!.getTime() + 10 * MIN))
    expect((await listFolios({ venueId: venueId! })).tarjetasPorAbrir.map(t => t.orderId)).toContain(oo.orderId)
    // Tarde: se libera sin pedido abrible (la clave del cargo) y el seguimiento dice que no se completó el pago.
    expect(await cargo(tarde.chargeId)).toMatchObject({ status: 'RELEASED', onlineOrderId: null })
    expect(liberacionesA(piTarde)[0][1]).toEqual({
      paymentIntentId: piTarde,
      idempotencyKey: `online-order-charge:${tarde.chargeId}:release`,
    })
    expect(await getTrackingByToken(tarde.trackingToken)).toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', paid: false })
    // Sin pagar: sigue esperando. El joven y el de «Mi equipo» no se visitaron.
    expect((await cargo(sinPagar.chargeId)).status).toBe('PENDING_AUTH')
    expect((await cargo(joven.chargeId)).status).toBe('PENDING_AUTH')
    expect((await cargo(miEquipo.chargeId)).status).toBe('PENDING_AUTH')
    // Una lectura de sesión por borrador visitado, y ninguna de los que no tocaba.
    const sesionesLeidas = authSpy.mock.calls.map(([, ref]) => ref.checkoutSessionId).filter(Boolean)
    const sesionDe = async (id: string) => (await cargo(id)).checkoutSessionId
    expect(sesionesLeidas.sort()).toEqual(
      [await sesionDe(atiempo.chargeId), await sesionDe(tarde.chargeId), await sesionDe(sinPagar.chargeId)].sort(),
    )
    expect(captureSpy).not.toHaveBeenCalled()
  })

  // ── Traspasos de 3A y 3B ────────────────────────────────────────────────────────────────────────────────────────────────────

  it('D661 · 3C: una pasada que empieza antes del plazo y escribe después no deja un pedido abrible vencido, y acceptedAt es la hora de la escritura', async () => {
    // La pasada empezó hace 60 s; el plazo (Stripe autorizó hace 10 min 20 s) cayó en medio: bajo el candado ya pasó.
    const inicio = hace(60_000)
    const d = await borrador()
    await prisma.onlineOrderCharge.update({ where: { id: d.chargeId }, data: { checkoutExpiresAt: new Date(inicio.getTime() - 1000) } })
    await pagar(d.chargeId, hace(10 * MIN + 20_000))
    await reconcileCardCharges(inicio, read => read())
    expect(await cargo(d.chargeId)).toMatchObject({ status: 'RELEASED', onlineOrderId: null })
    expect(await prisma.onlineOrder.count({ where: { trackingToken: d.trackingToken } })).toBe(0)
    expect(await getTrackingByToken(d.trackingToken)).toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', paid: false })

    // Un cobro en duda que Stripe ya hizo, anotado por una pasada que empezó hace 3 min: lo escrito lleva la hora de la escritura.
    const a = await apartado()
    await muereDespuesDeQueStripeCobro(a)
    await prisma.onlineOrderCharge.update({ where: { id: a.chargeId }, data: { updatedAt: hace(10 * MIN) } })
    const antes = new Date()
    await reconcileCardCharges(hace(3 * MIN), read => read())
    const oo = await cobradoUnaVez(a)
    expect(oo.acceptedAt!.getTime()).toBeGreaterThanOrEqual(antes.getTime())
    expect((await cargo(a.chargeId)).capturedAt).toEqual(oo.acceptedAt)
  })

  it('D661 · matriz: una captura que empezó antes de las 04:00 y se anotó después lleva acceptedAt de la escritura (el corte de ese día no la cierra)', async () => {
    // El último corte del día del negocio (04:00 en su zona) que ya pasó.
    const corte = fromZonedTime(`${formatInTimeZone(hace(4 * 60 * MIN), TZ, 'yyyy-MM-dd')}T04:00:00.000`, TZ)
    const a = await apartado()
    // La caja abrió antes del corte y Stripe cobró; Avoqado murió antes de anotarlo. La pasada que lo anota empezó antes del corte.
    await muereDespuesDeQueStripeCobro(a)
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { acceptDeadlineAt: new Date(corte.getTime() + MIN) } })
    await prisma.onlineOrderCharge.update({ where: { id: a.chargeId }, data: { updatedAt: new Date(corte.getTime() - 2 * MIN) } })
    await reconcileCardCharges(new Date(corte.getTime() - 30_000), read => read())
    const oo = await cobradoUnaVez(a)
    expect(oo.acceptedAt!.getTime()).toBeGreaterThan(corte.getTime())

    // El cierre del día que ya terminó no lo toca: es del día en que se anotó.
    await cerrarFoliosDelDiaTerminado({ venueId: venueId! }, () => new Date())
    expect((await enLinea(a.orderId)).status).toBe('ACCEPTED')
  })

  it('D661 · matriz: dos cajas abren, cae la ganadora y la segunda relee hasta el desenlace real', async () => {
    const a = await apartado()
    // La ganadora guarda CAPTURING y muere antes de que Stripe reciba la captura; la otra pierde el CAS.
    captureSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    authSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    const resultados = await Promise.all([abrir(a), abrir(a)])
    expect(resultados).toEqual([{ outcome: 'CONFIRMING_PAYMENT' }, { outcome: 'CONFIRMING_PAYMENT' }])
    expect(capturasA(a.pi)).toHaveLength(1)

    // La segunda relee: mientras no haya desenlace, «cobrando» y CONFIRMING_PAYMENT (nunca otro cobro).
    for (let i = 0; i < 2; i++) {
      await expect(abrir(a)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
      expect((await listFolios({ venueId: venueId! })).tarjetasPorAbrir).toContainEqual(
        expect.objectContaining({ orderId: a.orderId, cobrando: true }),
      )
    }
    expect(capturasA(a.pi)).toHaveLength(1)

    // El conciliador termina el cobro de la caja que cayó (dentro de su plazo); la segunda relee y ya lo ve «Por entregar».
    await expect(pasada(a.chargeId)).resolves.toMatchObject({ finished: 1 })
    await expect(abrir(a)).resolves.toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
    const caja = await listFolios({ venueId: venueId! })
    expect(caja.toDeliver.map(f => f.orderId)).toContain(a.orderId)
    expect(caja.tarjetasPorAbrir.map(t => t.orderId)).not.toContain(a.orderId)
    expect(capturasA(a.pi)).toHaveLength(2) // la que murió y el reintento, con la misma clave
    await cobradoUnaVez(a)
  })

  it('D661 · 3C: un cargo RELEASING cuya llamada a Stripe murió (la lectura de la caja ya no la espera) queda liberado en la siguiente pasada, una sola vez', async () => {
    const a = await apartado()
    await pagadaPorOtroCamino(a.orderId)
    // La lectura de la caja acepta la cuenta pagada y suelta la tarjeta sin esperarla; esa llamada a Stripe muere.
    voidSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    authSpy.mockImplementationOnce(async () => {
      throw murio()
    })
    await listFolios({ venueId: venueId! })
    await hastaQue(async () => liberacionesA(a.pi).length > 0 && authSpy.mock.calls.some(([, ref]) => ref.paymentIntentId === a.pi))
    await dormir(50)
    expect((await enLinea(a.orderId)).status).toBe('ACCEPTED')
    expect((await cargo(a.chargeId)).status).toBe('RELEASING')
    expect(pis.get(a.pi)).toBe('requires_capture')

    // La pasada del conciliador es el único reintento: la deja RELEASED.
    await expect(reconcileCardCharges(new Date(), read => read())).resolves.toMatchObject({ scanned: 1, released: 1, errors: 0 })
    expect((await cargo(a.chargeId)).status).toBe('RELEASED')
    expect(pis.get(a.pi)).toBe('canceled')
    expect(liberacionesA(a.pi)).toHaveLength(2)
    expect(liberacionesA(a.pi)[1][1]).toEqual({ paymentIntentId: a.pi, idempotencyKey: `online-order:${a.orderId}:release` })

    // Una sola vez: otra pasada ya no la toca, y la bitácora dice una liberación.
    await reconcileCardCharges(new Date(), read => read())
    expect(liberacionesA(a.pi)).toHaveLength(2)
    expect(
      (logAction as jest.Mock).mock.calls.filter(([p]) => p.action === 'ONLINE_ORDER_CARD_RELEASED' && p.entityId === a.onlineOrderId),
    ).toHaveLength(1)
    expect(await cobros(a.orderId)).toHaveLength(1) // sólo el otro cobro: la tarjeta nunca
    expect(captureSpy).not.toHaveBeenCalled()
  })
})
