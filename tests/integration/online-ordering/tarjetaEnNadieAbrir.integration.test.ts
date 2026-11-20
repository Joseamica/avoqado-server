// tests/integration/online-ordering/tarjetaEnNadieAbrir.integration.test.ts
/**
 * Integration (REAL DB) — D661 tarea 3A: confirmar → apartado; abrir = cobrar; vencer y liberar. Lo que los simulacros no prueban: el CAS
 * `AUTHORIZED → CAPTURING` con dos cajas a la vez, la relectura del plazo bajo el candado real (de admisión al confirmar, de la orden al
 * abrir) mientras otro lo sostiene, el sello del cargo y el rechazo en la MISMA transacción, y el trabajo de vencimiento con su SQL.
 * Stripe es un doble siempre (nunca el de verdad).
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { listFolios, syncPaidFolios } from '@/services/online-ordering/folios.service'
import { listInbox } from '@/services/online-ordering/inbox.service'
import { closesAt } from '@/services/online-ordering/hours'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { getTrackingByToken, lockAdmission } from '@/services/online-ordering/order.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { acceptOnlineOrder, rejectOnlineOrder } from '@/services/online-ordering/transitions.service'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { getOrder as leerCuentaEnLaTpv } from '@/services/tpv/order.tpv.service'
import { OnlineOrderAcceptanceExpiryJob } from '@/jobs/online-order-acceptance-expiry.job'

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
// Hay cocina que marcar: abrir deja la marca de comanda (`kitchenPendingAt`) en la escritura que acepta.
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn(async () => true),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))

const RUN = Date.now()
const MIN = 60_000
const TZ = 'America/Mexico_City'
const PUEDE_CREAR = { assertCanCreate: async () => {} }
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('D661 · 3A: confirmar → apartado; abrir = cobrar; vencer y liberar (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let productId: string
  const clientas: string[] = []
  let turno = 0
  /** Cada borrador con una clienta distinta: el tope por clienta (3) no es lo que se prueba aquí. */
  const siguienteClienta = () => clientas[turno++ % clientas.length]
  let seq = 0
  const llave = () => `abrir-${RUN}-${++seq}-`.padEnd(40, 'x')

  const sesiones = new Map<string, { id: string; url: string; expiresAt: Date }>()
  let checkoutSpy: jest.SpyInstance
  let authSpy: jest.SpyInstance
  let captureSpy: jest.SpyInstance
  let voidSpy: jest.SpyInstance
  let piSeq = 0
  /** Lo que Stripe contesta con la tarjeta apartada; `authorizedAt` = la hora en que Stripe la apartó. */
  const autorizada = (authorizedAt: Date, paymentIntentId = `pi_abrir_${RUN}_${++piSeq}`) => ({
    sessionStatus: 'complete',
    paymentIntentId,
    piStatus: 'requires_capture',
    amountCapturableCents: 25_000,
    amountReceivedCents: 0,
    captureBefore: new Date(Date.now() + 7 * 24 * 60 * MIN),
    card: { brand: 'visa', last4: '4242', funding: 'credit' },
    paymentMethodType: 'card',
    authorizedAt,
  })
  const cobrada = (p: { paymentIntentId: string; amountCents: number }) => ({
    sessionStatus: null,
    paymentIntentId: p.paymentIntentId,
    piStatus: 'succeeded',
    amountCapturableCents: 0,
    amountReceivedCents: p.amountCents,
    captureBefore: null,
    card: { brand: 'visa', last4: '4242', funding: 'credit' },
    paymentMethodType: 'card',
  })
  const perdida = () => Object.assign(new Error('se perdió la respuesta'), { type: 'StripeConnectionError' })

  /** El borrador de «Nadie» de una clienta con sesión (sin teléfono probado). */
  const borrador = () =>
    createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-abrir-${RUN}`,
        idempotencyKey: llave(),
        items: [{ productId, quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'Ana Nadie', email: 'ana@test.com' },
        customerId: siguienteClienta(),
        verifiedPhone: null,
      },
      PUEDE_CREAR,
    )
  const cargoDe = (trackingToken: string) => prisma.onlineOrderCharge.findUniqueOrThrow({ where: { trackingToken } })
  const cargo = (id: string) => prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id } })
  const enLinea = (orderId: string) => prisma.onlineOrder.findFirstOrThrow({ where: { orderId } })
  const cuenta = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const cobros = (orderId: string) => prisma.payment.findMany({ where: { orderId }, take: 10 })
  /** Confirmar con lo que Stripe dice (la hora de su autorización); `now` sólo si la prueba fija el reloj. */
  const confirmar = async (trackingToken: string, authorizedAt: Date, now?: Date) => {
    const c = await cargoDe(trackingToken)
    authSpy.mockResolvedValueOnce(autorizada(authorizedAt))
    return { outcome: await confirmCardAuthorization(c.id, now), chargeId: c.id }
  }
  /** Un apartado: borrador + autorización que Stripe hizo hace `haceMs`. */
  const apartado = async (haceMs = MIN) => {
    const d = await borrador()
    const { outcome, chargeId } = await confirmar(d.trackingToken, new Date(Date.now() - haceMs))
    expect(outcome).toBe('CREATED')
    const c = await cargo(chargeId)
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c.onlineOrderId! } })
    return { charge: c, orderId: oo.orderId, onlineOrderId: oo.id, trackingToken: d.trackingToken }
  }
  /** La caja actualizada abre el pedido (= lo cobra). */
  const abrir = (orderId: string, now?: Date) =>
    acceptOnlineOrder({ venueId: venueId!, orderId, staffId: null, abrirPagadoEnLinea: true, ...(now ? { now } : {}) })
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
  let evtSeq = 0
  const avisoDeStripe = (type: string, data: Record<string, unknown>) =>
    processStripeConnectWebhookEvent({ id: `evt_abrir_${RUN}_${++evtSeq}`, type, account: 'acct_itest_abrir', livemode: false, data })
  const pasarElTrabajo = () => new OnlineOrderAcceptanceExpiryJob({ cron: { start: jest.fn(), stop: jest.fn() } as never }).checkNow()
  /**
   * Fix 1: la cuenta se paga por otro camino. Es lo que deja la TPV al REGISTRAR dinero ya movido (`recordOrderPayment`, el único escritor
   * de caja que no se rechaza: su guarda va al empezar el cobro, `order.tpv.service.ts` → 409); se escribe directo: ese camino se prueba
   * contra Postgres en `folios.integration.test.ts`.
   */
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

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Abrir Org', slug: `itest-abrir-org-${RUN}`, email: `itest-abrir-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Abrir Venue',
        slug: `itest-abrir-${RUN}`,
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
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-abrir-${RUN}` } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-abrir-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `ABRIR-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    for (let i = 0; i < 25; i++) {
      clientas.push((await prisma.customer.create({ data: { venueId, email: `abrir${i}-${RUN}@test.com`, firstName: `Clienta ${i}` } })).id)
    }
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: 'ITEST Abrir',
        contactEmail: `itest-abrir-merchant-${RUN}@test.com`,
        publicKey: `pk_test_itest_abrir_${RUN}`,
        secretKeyHash: `itest-abrir-hash-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: 'acct_itest_abrir' },
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
        const id = `cs_itest_abrir_${RUN}_${sesiones.size + 1}`
        sesiones.set(p.idempotencyKey, { id, url: `https://checkout.stripe.test/${id}`, expiresAt: p.expiresAt })
      }
      return sesiones.get(p.idempotencyKey)!
    })
    authSpy.mockReset()
    captureSpy.mockReset()
    captureSpy.mockImplementation(async (_m: any, p: any) => cobrada(p))
    voidSpy.mockReset()
    voidSpy.mockImplementation(async (_m: any, p: any) => ({
      ...autorizada(new Date(), p.paymentIntentId),
      piStatus: 'canceled',
      amountCapturableCents: 0,
    }))
    // Lo de la prueba anterior queda resuelto: no ocupa el cupo de la sucursal en ésta.
    await prisma.onlineOrderCharge.updateMany({ where: { venueId: venueId!, status: 'PENDING_AUTH' }, data: { status: 'ABANDONED' } })
    await prisma.onlineOrder.updateMany({ where: { venueId: venueId!, status: 'PENDING_ACCEPTANCE' }, data: { status: 'EXPIRED' } })
    const ahora = new Date()
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: {
        requiresAcceptance: false,
        cardOnlineNadie: true,
        acceptsCardOnline: false,
        acceptsPayAtPickup: true,
        hours: Prisma.DbNull, // abierta todo el día salvo la prueba del cierre de la franja
        lastToPayPollAt: ahora,
        lastCardAlertPollAt: ahora,
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
    await prisma.paymentEffect.deleteMany({ where: v })
    await prisma.inventoryPosting.deleteMany({ where: v })
    await prisma.venueTransaction.deleteMany({ where: v })
    await prisma.payment.deleteMany({ where: v })
    await prisma.onlineOrderCharge.deleteMany({ where: v }) // antes del comercio (Restrict)
    await prisma.onlineOrder.deleteMany({ where: v })
    await prisma.order.deleteMany({ where: v })
    await prisma.ecommerceMerchant.deleteMany({ where: v })
    await prisma.product.deleteMany({ where: v })
    await prisma.menuCategory.deleteMany({ where: v })
    await prisma.customer.deleteMany({ where: v })
    await prisma.onlineOrderingSettings.deleteMany({ where: v })
    await prisma.privacyNoticeVersion.deleteMany({ where: v })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('«Nadie»: al confirmar NO se captura; el pedido queda PENDING_ACCEPTANCE con el cargo AUTHORIZED y sale en tarjetasPorAbrir, nunca en toPay', async () => {
    const autorizo = new Date(Date.now() - 2 * MIN)
    const d = await borrador()
    const { outcome, chargeId } = await confirmar(d.trackingToken, autorizo)
    expect(outcome).toBe('CREATED')

    expect(captureSpy).not.toHaveBeenCalled()
    const c = await cargo(chargeId)
    expect(c.status).toBe('AUTHORIZED')
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c.onlineOrderId! } })
    expect(oo).toMatchObject({ status: 'PENDING_ACCEPTANCE', requiresAcceptance: false, paymentMode: 'CARD_ONLINE' })
    // Ruling 10: el plazo corre desde que Stripe autorizó (no desde que Avoqado se enteró).
    expect(oo.acceptDeadlineAt).toEqual(new Date(autorizo.getTime() + 10 * MIN))
    expect(await cuenta(oo.orderId)).toMatchObject({ paymentStatus: 'PENDING', status: 'PENDING' })
    expect(await cobros(oo.orderId)).toHaveLength(0)
    // El seguimiento ya dice el modo del pedido.
    expect(await getTrackingByToken(d.trackingToken)).toMatchObject({
      status: 'PENDING_ACCEPTANCE',
      cardStatus: 'AUTHORIZED',
      requiresAcceptance: false,
    })
    // 3B agrega las aserciones de `tarjetasPorAbrir` (y que nunca sale en `toPay`): esa lista todavía no existe en esta rebanada.
  })

  it('abrir (accept) con orders:update captura → CAPTURED, Order PAID, ACCEPTED con kitchenPendingAt y acceptedAt de la escritura; sale de tarjetasPorAbrir y entra a toDeliver', async () => {
    const a = await apartado()
    // Sin la apertura explícita de una caja actualizada no se cobra (la API la exige por sus rutas; aquí, el servicio).
    await expect(acceptOnlineOrder({ venueId: venueId!, orderId: a.orderId, staffId: null })).resolves.toEqual({
      outcome: 'OPEN_FROM_CAJA',
    })
    expect(captureSpy).not.toHaveBeenCalled()

    let cobradoEn = 0
    captureSpy.mockImplementation(async (_m: any, p: any) => {
      await dormir(50) // Stripe tarda: lo escrito lleva la hora de DESPUÉS
      cobradoEn = Date.now()
      return cobrada(p)
    })
    await expect(abrir(a.orderId)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })

    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(captureSpy.mock.calls[0][1]).toEqual({
      paymentIntentId: a.charge.paymentIntentId,
      amountCents: 25_000,
      applicationFeeCents: 290,
      idempotencyKey: `online-order:${a.orderId}:capture`,
    })
    const c = await cargo(a.charge.id)
    expect(c.status).toBe('CAPTURED')
    expect(c.capturedAmount!.toFixed(2)).toBe('250.00')
    const pagos = await cobros(a.orderId)
    expect(pagos).toHaveLength(1)
    expect(pagos[0].amount.toFixed(2)).toBe('250.00')
    const order = await cuenta(a.orderId)
    expect(order).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' })
    const oo = await enLinea(a.orderId)
    expect(oo.status).toBe('ACCEPTED')
    expect(oo.acceptedAt!.getTime()).toBeGreaterThanOrEqual(cobradoEn)
    expect(order.kitchenPendingAt).toEqual(oo.acceptedAt)
    // Entra a «Por entregar» de la caja. 3B agrega que sale de `tarjetasPorAbrir`.
    expect((await listFolios({ venueId: venueId! })).toDeliver.map(f => f.orderId)).toContain(a.orderId)
  })

  it('dos cajas abren a la vez: una sola captura; la otra recibe CONFIRMING_PAYMENT o el estado ACCEPTED, no un error', async () => {
    const a = await apartado()
    captureSpy.mockImplementation(async (_m: any, p: any) => {
      await dormir(300)
      return cobrada(p)
    })
    const resultados = await Promise.all([abrir(a.orderId), abrir(a.orderId)])
    expect(resultados.filter(r => r.outcome === 'OK')).toHaveLength(1)
    const otra = resultados.find(r => r.outcome !== 'OK')!
    expect([{ outcome: 'CONFIRMING_PAYMENT' }, { outcome: 'STALE', status: 'ACCEPTED' }]).toContainEqual(otra)
    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(await cobros(a.orderId)).toHaveLength(1)
    expect((await cargo(a.charge.id)).status).toBe('CAPTURED')
  })

  it('la segunda apertura recibe CONFIRMING_PAYMENT o STALE (409); la caja relee el pedido y lo muestra en «Por entregar»', async () => {
    const a = await apartado()
    // La primera caja se queda cobrando hasta que se le suelte.
    let soltarStripe!: () => void
    const stripeContesta = new Promise<void>(r => (soltarStripe = r))
    let entroACobrar!: () => void
    const cobrando = new Promise<void>(r => (entroACobrar = r))
    captureSpy.mockImplementation(async (_m: any, p: any) => {
      entroACobrar()
      await stripeContesta
      return cobrada(p)
    })
    const primera = abrir(a.orderId)
    await cobrando
    // Mientras el banco cobra: CONFIRMING_PAYMENT (la API lo responde 409 ONLINE_ORDER_CONFIRMING_PAYMENT), sin otro cobro.
    await expect(abrir(a.orderId)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    soltarStripe()
    await expect(primera).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    // Ya abierto: STALE con su estado (la API, 409 ORDER_STATE_CHANGED); la caja relee y lo ve en «Por entregar».
    await expect(abrir(a.orderId)).resolves.toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect((await listFolios({ venueId: venueId!, section: 'toDeliver' })).toDeliver.map(f => f.orderId)).toContain(a.orderId)
  })

  it('la captura falla → cargo CAPTURE_FAILED/liberado y pedido REJECTED PAYMENT_FAILED en la misma transacción', async () => {
    const a = await apartado()
    captureSpy.mockRejectedValue(Object.assign(new Error('canceled'), { type: 'StripeInvalidRequestError' }))
    authSpy.mockResolvedValue({ ...autorizada(new Date(), a.charge.paymentIntentId!), piStatus: 'canceled', amountCapturableCents: 0 })

    await expect(abrir(a.orderId)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    expect((await cuenta(a.orderId)).status).toBe('CANCELLED')
    expect((await cargo(a.charge.id)).status).toBe('CAPTURE_FAILED')
    expect(await cobros(a.orderId)).toHaveLength(0)
    expect(voidSpy).not.toHaveBeenCalled() // Stripe ya no lo tenía apartado
    // Nunca otro intento de cobro sobre el rechazado.
    await expect(abrir(a.orderId)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(captureSpy).toHaveBeenCalledTimes(1)
  })

  it('D661: un apartado de tarjeta de «Nadie» tampoco se rechaza a mano (R46): sigue apartado y abrible', async () => {
    const a = await apartado()
    await expect(rejectOnlineOrder({ venueId: venueId!, orderId: a.orderId, staffId: null, reason: 'OTHER' })).resolves.toEqual({
      outcome: 'STALE',
      status: 'PENDING_ACCEPTANCE',
    })
    expect((await cargo(a.charge.id)).status).toBe('AUTHORIZED')
    expect(voidSpy).not.toHaveBeenCalled()
    await expect(abrir(a.orderId)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
  })

  it('nadie lo abre en 10 min → el job lo vence y libera el apartado; nunca se cobra', async () => {
    const a = await apartado()
    // Pasaron los 10 minutos sin que una caja lo abriera.
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 1000) } })
    await pasarElTrabajo()

    expect(await enLinea(a.orderId)).toMatchObject({ status: 'EXPIRED' })
    expect((await cuenta(a.orderId)).status).toBe('CANCELLED')
    const c = await cargo(a.charge.id)
    expect(c.status).toBe('RELEASED')
    expect(voidSpy).toHaveBeenCalledWith(expect.anything(), {
      paymentIntentId: a.charge.paymentIntentId,
      idempotencyKey: `online-order:${a.orderId}:release`,
    })
    // Una caja que lo abre tarde no lo cobra.
    await expect(abrir(a.orderId)).resolves.toEqual({ outcome: 'STALE', status: 'EXPIRED' })
    expect(captureSpy).not.toHaveBeenCalled()
    expect(await cobros(a.orderId)).toHaveLength(0)
    expect(await getTrackingByToken(a.trackingToken)).toMatchObject({ status: 'EXPIRED', cardStatus: 'RELEASED', paid: false })
  })

  it('D661 · matriz: vencer con la respuesta de Stripe perdida deja EXPIRED + RELEASING; la pasada repetida no duplica nada y el aviso de cancelación lo deja RELEASED', async () => {
    const a = await apartado()
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { acceptDeadlineAt: new Date(Date.now() - 1000) } })
    voidSpy.mockRejectedValue(perdida())
    authSpy.mockRejectedValue(perdida()) // tampoco contesta la relectura

    await pasarElTrabajo()
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'EXPIRED' })
    expect((await cargo(a.charge.id)).status).toBe('RELEASING')
    expect(await getTrackingByToken(a.trackingToken)).toMatchObject({ status: 'EXPIRED', cardStatus: 'RELEASING', paid: false })

    // La pasada se repite: el pedido ya no es candidato; nada se cobra ni se reescribe.
    const llamadas = voidSpy.mock.calls.length
    await pasarElTrabajo()
    expect(voidSpy.mock.calls.length).toBe(llamadas)
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'EXPIRED' })

    // Llega el aviso de Stripe de que el PaymentIntent se canceló: el cargo queda RELEASED (sin rechazar un pedido ya vencido).
    authSpy.mockReset()
    authSpy.mockResolvedValue({ ...autorizada(new Date(), a.charge.paymentIntentId!), piStatus: 'canceled', amountCapturableCents: 0 })
    await avisoDeStripe('payment_intent.canceled', {
      id: a.charge.paymentIntentId,
      metadata: { type: 'online_order', chargeId: a.charge.id, venueId: venueId! },
    })
    expect((await cargo(a.charge.id)).status).toBe('RELEASED')
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'EXPIRED' })
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('el webhook que libera un AUTHORIZED de «Nadie» (payment_intent.canceled) cierra el pedido como en «Mi equipo»', async () => {
    const a = await apartado()
    authSpy.mockResolvedValueOnce({ ...autorizada(new Date(), a.charge.paymentIntentId!), piStatus: 'canceled', amountCapturableCents: 0 })
    await avisoDeStripe('payment_intent.canceled', {
      id: a.charge.paymentIntentId,
      metadata: { type: 'online_order', chargeId: a.charge.id, venueId: venueId! },
    })
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'REJECTED', rejectReason: 'PAYMENT_FAILED' })
    expect((await cuenta(a.orderId)).status).toBe('CANCELLED')
    const c = await cargo(a.charge.id)
    expect(c.status).toBe('RELEASED')
    expect(c.releasedAt).toBeInstanceOf(Date)
    expect(voidSpy).not.toHaveBeenCalled() // Stripe ya lo canceló
    await expect(abrir(a.orderId)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('el plazo del apartado es min(confirmar + 10 min, cierre de la franja del horario en que empezó el borrador); si la autorización llega después de ese límite, se libera sin crear un pedido abrible; abrir comprueba el límite bajo el candado antes de reclamar la captura', async () => {
    // Un horario cuya franja de hoy cierra en ~16 min (en la zona del negocio): todavía se reciben pedidos (último pedido: 10 min antes).
    const hhmm = (ms: number) => formatInTimeZone(new Date(Date.now() + ms), TZ, 'HH:mm')
    const dia = { enabled: true, ranges: [{ open: hhmm(-60 * MIN), close: hhmm(16 * MIN) }] }
    const HORARIO = { monday: dia, tuesday: dia, wednesday: dia, thursday: dia, friday: dia, saturday: dia, sunday: dia }
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { hours: HORARIO } })

    // El borrador guarda el cierre de SU franja.
    const empiezo = new Date()
    const d1 = await borrador()
    const cierreGuardado = ((await cargoDe(d1.trackingToken)).request as { cierreDeFranja?: string | null }).cierreDeFranja
    const cierre = closesAt(HORARIO, empiezo, TZ)!
    expect(cierreGuardado).toBe(cierre.toISOString())
    expect(cierre.getTime() - empiezo.getTime()).toBeGreaterThan(14 * MIN)
    expect(cierre.getTime() - empiezo.getTime()).toBeLessThanOrEqual(16 * MIN)

    // (a) Stripe autorizó 5 min antes del cierre: su +10 min pasa del cierre, así que el plazo es el cierre.
    const autorizo1 = new Date(cierre.getTime() - 5 * MIN)
    const c1 = await confirmar(d1.trackingToken, autorizo1, new Date(autorizo1.getTime() + 1000))
    expect(c1.outcome).toBe('CREATED')
    const oo1 = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: (await cargo(c1.chargeId)).onlineOrderId! } })
    expect(oo1.acceptDeadlineAt).toEqual(cierre)
    // Una caja lo abre un minuto después del cierre: bajo el candado ve el plazo vencido, lo vence y libera; nunca cobra.
    await expect(abrir(oo1.orderId, new Date(cierre.getTime() + MIN))).resolves.toEqual({ outcome: 'STALE', status: 'EXPIRED' })
    expect(captureSpy).not.toHaveBeenCalled()
    expect((await cargo(c1.chargeId)).status).toBe('RELEASED')

    // (b) El ejemplo: el borrador empezó antes del cierre, la franja cerró, y Stripe autorizó 10 min DESPUÉS del cierre → liberado.
    const d2 = await borrador()
    const paga = new Date(cierre.getTime() + 10 * MIN)
    const c2 = await confirmar(d2.trackingToken, paga, new Date(paga.getTime() + 5000))
    expect(c2.outcome).toBe('RELEASED_LATE')
    const libre = await cargo(c2.chargeId)
    expect(libre).toMatchObject({ status: 'RELEASED', onlineOrderId: null, lastError: null })
    expect(
      await prisma.order.count({ where: { venueId: venueId!, externalId: (libre.request as { externalId: string }).externalId } }),
    ).toBe(0)
    expect(voidSpy).toHaveBeenLastCalledWith(expect.anything(), {
      paymentIntentId: libre.paymentIntentId,
      idempotencyKey: `online-order-charge:${libre.id}:release`,
    })
    expect(await getTrackingByToken(d2.trackingToken)).toMatchObject({
      status: 'PAYMENT_NOT_COMPLETED',
      cardStatus: 'RELEASED',
      paid: false,
      requiresAcceptance: false,
    })
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('D661 (Ruling 10): una confirmación o una apertura que cruza el plazo mientras espera su candado no crea ni cobra: libera', async () => {
    // Confirmar: Stripe autorizó hace 9 min 58.5 s (plazo en 1.5 s) y otra admisión sostiene el candado 2.5 s.
    const d = await borrador()
    const c = await cargoDe(d.trackingToken)
    authSpy.mockResolvedValueOnce(autorizada(new Date(Date.now() - 10 * MIN + 1500)))
    const admision = sostener(tx => lockAdmission(tx, venueId!), 2500)
    await admision.listo
    const confirmacion = confirmCardAuthorization(c.id) // sin `now`: el reloj de verdad, leído bajo el candado
    await admision.hecho
    await expect(confirmacion).resolves.toBe('RELEASED_LATE')
    expect(await cargo(c.id)).toMatchObject({ status: 'RELEASED', onlineOrderId: null })

    // Abrir: un apartado con plazo en 3 s y otra transacción sostiene el candado de la orden 4 s.
    const a = await apartado(10 * MIN - 3000)
    const orden = sostener(tx => lockExistingOrderForPayment(tx, { venueId: venueId!, orderId: a.orderId }), 4000)
    await orden.listo
    const apertura = abrir(a.orderId) // sin `now`
    await orden.hecho
    await expect(apertura).resolves.toEqual({ outcome: 'STALE', status: 'EXPIRED' })
    expect(captureSpy).not.toHaveBeenCalled()
    expect((await cargo(a.charge.id)).status).toBe('RELEASED')
  })

  it('D661 · matriz (Ruling 10): una autorización tardía cortada antes y después de cancelar en Stripe queda RELEASING sin pedido (el seguimiento dice que no se completó el pago); el reintento la deja RELEASED', async () => {
    // Antes: Stripe no contesta la cancelación ni la relectura.
    const d = await borrador()
    voidSpy.mockRejectedValueOnce(perdida())
    const c = await cargoDe(d.trackingToken)
    authSpy.mockResolvedValueOnce(autorizada(new Date(Date.now() - 11 * MIN))).mockRejectedValueOnce(perdida())
    await expect(confirmCardAuthorization(c.id)).rejects.toThrow(/conciliador/)
    expect(await cargo(c.id)).toMatchObject({ status: 'RELEASING', onlineOrderId: null })
    expect(await getTrackingByToken(d.trackingToken)).toMatchObject({
      status: 'PAYMENT_NOT_COMPLETED',
      cardStatus: 'RELEASING',
      paid: false,
      requiresAcceptance: false,
    })
    // Otra confirmación (aviso, seguimiento, conciliador) ya no lo vuelve pedido.
    await expect(confirmCardAuthorization(c.id)).resolves.toBe('ALREADY')
    // Después: Stripe sí lo canceló pero la respuesta se perdió; la relectura lo confirma y queda RELEASED.
    voidSpy.mockRejectedValueOnce(perdida())
    authSpy.mockResolvedValueOnce({ ...autorizada(new Date(), (await cargo(c.id)).paymentIntentId!), piStatus: 'canceled' })
    await expect(releaseCharge(c.id)).resolves.toBe('RELEASED')
    expect(await cargo(c.id)).toMatchObject({ status: 'RELEASED', onlineOrderId: null })
    expect(await getTrackingByToken(d.trackingToken)).toMatchObject({ status: 'PAYMENT_NOT_COMPLETED', cardStatus: 'RELEASED' })
    expect(await prisma.onlineOrder.count({ where: { trackingToken: d.trackingToken } })).toBe(0)
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('D661 (fix 1): un apartado cuya cuenta se pagó por otro camino queda «Por entregar» con su tarjeta liberada al pasar el barrido (la lista de la caja, la bandeja y el trabajo de vencimiento); nunca se cobra', async () => {
    const barridos: Array<[string, () => Promise<unknown>]> = [
      ['lista de la caja', () => listFolios({ venueId: venueId! })],
      ['bandeja', () => listInbox({ venueId: venueId!, filter: 'all' })],
      ['trabajo de vencimiento', pasarElTrabajo],
    ]
    for (const [quien, barrer] of barridos) {
      const a = await apartado()
      await pagadaPorOtroCamino(a.orderId)
      await barrer()
      expect({ quien, pedido: (await enLinea(a.orderId)).status }).toEqual({ quien, pedido: 'ACCEPTED' })
      expect({ quien, cargo: (await cargo(a.charge.id)).status }).toEqual({ quien, cargo: 'RELEASED' })
      expect(voidSpy).toHaveBeenCalledWith(expect.anything(), {
        paymentIntentId: a.charge.paymentIntentId,
        idempotencyKey: `online-order:${a.orderId}:release`,
      })
      expect(await cobros(a.orderId)).toHaveLength(1) // sólo el otro cobro: la tarjeta nunca
      // Y una caja que lo abre después no lo cobra: ya está «Por entregar».
      await expect(abrir(a.orderId)).resolves.toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
    }
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('D661 (fix 1): con Stripe sin contestar, el barrido acepta la cuenta pagada y deja el cargo RELEASING en esa MISMA transacción (nunca AUTHORIZED detrás de un pedido aceptado)', async () => {
    const a = await apartado()
    await pagadaPorOtroCamino(a.orderId)
    voidSpy.mockRejectedValue(perdida())
    authSpy.mockRejectedValue(perdida())
    await syncPaidFolios({ venueId: venueId! }, () => new Date())
    expect((await enLinea(a.orderId)).status).toBe('ACCEPTED')
    expect((await cargo(a.charge.id)).status).toBe('RELEASING') // el conciliador libera todo RELEASING
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('D661 (fix 1): el barrido y una caja que abre el mismo apartado ya pagado a la vez: un solo desenlace, sin captura ni segundo cobro', async () => {
    // Las dos esperan el MISMO candado de la orden, que otra transacción sostiene; entra primero la que llegó primero a la fila.
    for (const primero of ['barrido', 'caja'] as const) {
      const a = await apartado()
      await pagadaPorOtroCamino(a.orderId)
      const orden = sostener(tx => lockExistingOrderForPayment(tx, { venueId: venueId!, orderId: a.orderId }), 1500)
      await orden.listo
      const barrer = () => syncPaidFolios({ venueId: venueId! }, () => new Date())
      const p1 = primero === 'barrido' ? barrer() : abrir(a.orderId)
      await dormir(300) // la primera ya espera el candado
      const p2 = primero === 'barrido' ? abrir(a.orderId) : barrer()
      await orden.hecho
      const resultados = await Promise.all([p1, p2])
      const apertura = (primero === 'barrido' ? resultados[1] : resultados[0]) as Awaited<ReturnType<typeof abrir>>
      expect([
        { primero, outcome: 'OK', status: 'ACCEPTED' },
        { primero, outcome: 'STALE', status: 'ACCEPTED' },
      ]).toContainEqual({ primero, outcome: apertura.outcome, status: 'status' in apertura ? apertura.status : undefined })
      expect({ primero, pedido: (await enLinea(a.orderId)).status }).toEqual({ primero, pedido: 'ACCEPTED' })
      expect({ primero, cargo: (await cargo(a.charge.id)).status }).toEqual({ primero, cargo: 'RELEASED' })
      expect(await cobros(a.orderId)).toHaveLength(1)
    }
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('D661 (fix 1): la caja no cobra un apartado de «Nadie»: el efectivo del POS → 409 ONLINE_ORDER_PAID_BY_CARD sin ningún Payment, y la TPV no lo abre para cobrarlo (409)', async () => {
    const a = await apartado()
    await expect(payCashOrder(venueId!, a.orderId, { amount: 25_000, tip: 0, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_PAID_BY_CARD',
    })
    await expect(leerCuentaEnLaTpv(venueId!, a.orderId)).rejects.toMatchObject({ statusCode: 409, code: 'ONLINE_ORDER_PAID_BY_CARD' })
    expect(await cobros(a.orderId)).toHaveLength(0)
    expect(await cuenta(a.orderId)).toMatchObject({ paymentStatus: 'PENDING' })
    expect((await cargo(a.charge.id)).status).toBe('AUTHORIZED')
  })

  it('«Mi equipo» con tarjeta sigue igual', async () => {
    // Un borrador de «Mi equipo» (con teléfono, sin sesión) creado ANTES de que la tienda pasara a «Nadie».
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { requiresAcceptance: true, acceptsCardOnline: true },
    })
    const d = await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-abrir-${RUN}`,
        idempotencyKey: llave(),
        items: [{ productId, quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'Eva Equipo', phone: '55 1234 9999' },
        customerId: null,
        verifiedPhone: null,
      },
      PUEDE_CREAR,
    )
    expect((await cargoDe(d.trackingToken)).request).not.toHaveProperty('cierreDeFranja')
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { requiresAcceptance: false, acceptsCardOnline: false },
    })

    // Se confirma con la tienda ya en «Nadie»: nace «Mi equipo», con el plazo de siempre (confirmar + 10 min, no la hora de Stripe).
    const ahora = new Date()
    const { outcome, chargeId } = await confirmar(d.trackingToken, new Date(ahora.getTime() - 9 * MIN), ahora)
    expect(outcome).toBe('CREATED')
    const c = await cargo(chargeId)
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c.onlineOrderId! } })
    expect(oo).toMatchObject({ requiresAcceptance: true, status: 'PENDING_ACCEPTANCE' })
    expect(oo.acceptDeadlineAt).toEqual(new Date(ahora.getTime() + 10 * MIN))
    // Se acepta (y cobra) sin el campo nuevo, como siempre.
    await expect(acceptOnlineOrder({ venueId: venueId!, orderId: oo.orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'ACCEPTED',
    })
    expect((await cargo(chargeId)).status).toBe('CAPTURED')
    expect(await cobros(oo.orderId)).toHaveLength(1)
  })
})
