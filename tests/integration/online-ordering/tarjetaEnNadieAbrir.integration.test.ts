// tests/integration/online-ordering/tarjetaEnNadieAbrir.integration.test.ts
/**
 * Integration (REAL DB) — D661 tarea 3A: confirmar → apartado; abrir = cobrar; vencer y liberar. Lo que los simulacros no prueban: el CAS
 * `AUTHORIZED → CAPTURING` con dos cajas a la vez, la relectura del plazo bajo el candado real (de admisión al confirmar, de la orden al
 * abrir) mientras otro lo sostiene, el sello del cargo y el rechazo en la MISMA transacción, y el trabajo de vencimiento con su SQL.
 * Tarea 3B: lo que lee la caja (`tarjetasPorAbrir`, `comandasPorImprimir`, `pollSeconds`), el latido de la caja que avisa por la ruta
 * real y su séptima columna (`cardAlertFastPollAt`, Ruling 7), y el reclamo de papel con su CAS y `posibleRepetida` (Ruling 9).
 * Stripe es un doble siempre (nunca el de verdad).
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { cardOnlineAvailable } from '@/services/online-ordering/card/merchant'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { cerrarFoliosDelDiaTerminado, listFolios, syncPaidFolios } from '@/services/online-ordering/folios.service'
import { claimOnlineOrderPrint, confirmOnlineOrderPrinted } from '@/services/online-ordering/printClaim.service'
import { __resetCardAlertPollDebounceForTests } from '@/services/online-ordering/cardAlertPresence'
import { __resetPresenceDebounceForTests } from '@/services/online-ordering/presence.service'
import * as ctrl from '@/controllers/mobile/onlineOrders.mobile.controller'
import mobileRouter from '@/routes/mobile/onlineOrders.mobile.routes'
import tpvRouter from '@/routes/tpv/onlineOrders.tpv.routes'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { listInbox } from '@/services/online-ordering/inbox.service'
import { closesAt } from '@/services/online-ordering/hours'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import * as cotizacion from '@/services/online-ordering/quote.service'
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

// Ruling 14: la sesión de la caja (el JWT) la dan las cabeceras de la prueba; el permiso y la sucursal se resuelven de verdad en la base.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  __esModule: true,
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: req.headers['x-test-staff'], venueId: req.headers['x-test-venue'], role: 'CASHIER' }
    next()
  },
}))
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
/** Espera (con tope) a que algo que corre sin esperarlo termine: la liberación con Stripe sale fuera de la lectura de la caja (3B). */
const hastaQue = async (listo: () => Promise<boolean>, ms = 5_000) => {
  const fin = Date.now() + ms
  while (!(await listo()) && Date.now() < fin) await dormir(25)
}

describe('D661 · 3A y 3B: confirmar → apartado; abrir = cobrar; vencer y liberar; lo que lee la caja (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  /** Una cajera de la sucursal: puede cobrar (`payments:create`) y abrir (`orders:update`). */
  let staffId: string | undefined
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
  /** El cargo quedó liberado: su liberación con Stripe corre sin que la lectura que lo aceptó la espere (3B). */
  const liberado = (chargeId: string) => hastaQue(async () => (await cargo(chargeId)).status === 'RELEASED')
  /** La caja actualizada (TPV o POS) que sabe avisar: cobra folios y avisa pedidos pagados en línea. */
  const AMBAS = { 'x-online-orders-to-pay': '1', 'x-online-orders-card-alert': '1' }
  /** La caja consulta to-pay por el controlador REAL (permisos reales, latidos reales), como la cajera de la sucursal. */
  const sondeo = async (headers: Record<string, string> = AMBAS) => {
    let body: any
    const res: any = { status: jest.fn(() => res), json: jest.fn((b: unknown) => ((body = b), res)) }
    const next = jest.fn()
    const req: any = {
      params: { venueId: venueId! },
      query: {},
      body: {},
      authContext: { userId: staffId! },
      header: (n: string) => headers[n.toLowerCase()],
    }
    await ctrl.toPay(req, res, next)
    expect(next).not.toHaveBeenCalled()
    return body.data
  }
  /** Lo ya cobrado por entregar de pruebas anteriores se da por entregado: sólo cuenta lo de esta prueba. */
  /**
   * Lo de pruebas anteriores se da por entregado CON su comanda ya impresa: así no ocupa `comandasPorImprimir` (tope 50, del más viejo)
   * y lo de cada prueba nunca se queda fuera de la lista por crecer el archivo.
   */
  const sinNadaVivo = () =>
    prisma.onlineOrder.updateMany({
      where: { venueId: venueId!, OR: [{ status: { in: ['ACCEPTED', 'READY'] } }, { status: 'COMPLETED', printedAt: null }] },
      data: { status: 'COMPLETED', printedAt: new Date() },
    })
  /** Un apartado que una caja ya abrió (cobrado, «Por entregar», con la comanda pendiente). */
  const cobrado = async () => {
    const a = await apartado()
    await expect(abrir(a.orderId)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    return a
  }
  const comandas = async () => (await listFolios({ venueId: venueId! })).comandasPorImprimir.map(c => c.orderId)
  /** Ruling 14: las rutas REALES de la caja (POS y TPV), con la sesión de la cajera de la sucursal. */
  const cajas = express()
  cajas.use(express.json())
  cajas.use('/m/venues/:venueId/online-orders', mobileRouter)
  cajas.use('/t/venues/:venueId/online-orders', tpvRouter)
  cajas.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ code: err.code, error: err.message }))
  const leerPedido = (namespace: 'm' | 't', orderId: string) =>
    request(cajas)
      .get(`/${namespace}/venues/${venueId}/online-orders/${orderId}`)
      .set('x-test-staff', staffId!)
      .set('x-test-venue', venueId!)
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
    staffId = (
      await prisma.staff.create({ data: { email: `itest-abrir-caja-${RUN}@test.com`, firstName: 'Caja', lastName: 'ITEST', active: true } })
    ).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
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
        // La tienda encendida: una prueba que la apagó y falló antes de prenderla no tumba en cascada a las siguientes.
        enabled: true,
        requiresAcceptance: false,
        cardOnlineNadie: true,
        acceptsCardOnline: false,
        acceptsPayAtPickup: true,
        hours: Prisma.DbNull, // abierta todo el día salvo la prueba del cierre de la franja
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
    await prisma.staffVenue.deleteMany({ where: v })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
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
    // 3B: la caja lo ve para ABRIRLO, nunca para cobrarlo en caja (ni en «Por pagar» ni en su conteo), y sondea cada 30 s.
    const caja = await listFolios({ venueId: venueId! })
    expect(caja.tarjetasPorAbrir).toContainEqual({
      orderId: oo.orderId,
      orderNumber: (await cuenta(oo.orderId)).orderNumber,
      customerName: (await cuenta(oo.orderId)).customerName ?? '',
      total: 250, // Ruling 13: en pesos, como los folios
      createdAt: oo.createdAt.toISOString(),
      cobrando: false,
    })
    for (const t of caja.tarjetasPorAbrir) expect(t).not.toHaveProperty('totalCents')
    expect(caja.toPay.map(f => f.orderId)).not.toContain(oo.orderId)
    expect(caja.counts.toPay).toBe(0) // la prueba anterior quedó vencida (beforeEach): no hay folios por cobrar
    expect(caja.pollSeconds).toBe(30)
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
    // Entra a «Por entregar» de la caja y sale de `tarjetasPorAbrir` (misma foto: nunca en las dos).
    const caja = await listFolios({ venueId: venueId! })
    expect(caja.toDeliver.map(f => f.orderId)).toContain(a.orderId)
    expect(caja.tarjetasPorAbrir.map(t => t.orderId)).not.toContain(a.orderId)
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
      await liberado(a.charge.id)
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
    // 3B: la liberación corre sin que la lectura la espere; aquí se espera a que su intento con Stripe termine (sin respuesta).
    await hastaQue(async () => authSpy.mock.calls.length > 0)
    await dormir(50)
    expect((await cargo(a.charge.id)).status).toBe('RELEASING')
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
      await liberado(a.charge.id)
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
  // ─── 3B: lo que lee la caja ───────────────────────────────────────────────────────────────────────────────────────────────────

  it('tarjetasPorAbrir mantiene pollSeconds 30 y la sección visible mientras tenga algo, aunque la tienda cambie a «Mi equipo» o se apague', async () => {
    await sinNadaVivo()
    const a = await apartado()
    for (const ajustes of [{ requiresAcceptance: true }, { requiresAcceptance: false, enabled: false }]) {
      await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: ajustes })
      const caja = await listFolios({ venueId: venueId! })
      expect({ ajustes, showTile: caja.showTile, pollSeconds: caja.pollSeconds, abrir: caja.tarjetasPorAbrir.map(t => t.orderId) }).toEqual(
        {
          ajustes,
          showTile: true,
          pollSeconds: 30,
          abrir: [a.orderId],
        },
      )
      expect(caja.toPay.map(f => f.orderId)).not.toContain(a.orderId)
    }
    // Resuelto (aquí, vencido) con la tienda apagada y nada más vivo: la sección se va y vuelve la espera larga.
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { status: 'EXPIRED' } })
    expect(await listFolios({ venueId: venueId! })).toMatchObject({ showTile: false, pollSeconds: 600, tarjetasPorAbrir: [] })
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { enabled: true } })
  })

  it('pollSeconds es 30 también mientras exista en el negocio un BORRADOR D661 vivo (PENDING_AUTH) que todavía pueda autorizarse, aunque tarjetasPorAbrir esté vacía o la tienda haya cambiado de modo', async () => {
    await sinNadaVivo()
    const d = await borrador()
    // La tienda cambia a «Mi equipo» y la página de pago del borrador ya venció: Stripe pudo autorizar igual. Hasta que el conciliador
    // lo resuelva, la caja sigue en 30 s (si se aparta, suena a tiempo).
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: true } })
    await prisma.onlineOrderCharge.update({
      where: { trackingToken: d.trackingToken },
      data: { checkoutExpiresAt: new Date(Date.now() - MIN) },
    })
    for (const enabled of [true, false]) {
      await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { enabled } })
      const caja = await listFolios({ venueId: venueId! })
      expect({ enabled, abrir: caja.tarjetasPorAbrir, showTile: caja.showTile, pollSeconds: caja.pollSeconds }).toEqual({
        enabled,
        abrir: [],
        showTile: false,
        pollSeconds: 30,
      })
    }
    // Resuelto (abandonado): la espera larga.
    await prisma.onlineOrderCharge.update({ where: { trackingToken: d.trackingToken }, data: { status: 'ABANDONED' } })
    expect((await listFolios({ venueId: venueId! })).pollSeconds).toBe(600)
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { enabled: true } })
  })

  it('D661 (3B): mientras una caja lo cobra, el apartado sigue en tarjetasPorAbrir con cobrando:true; al terminar pasa a «Por entregar»', async () => {
    const a = await apartado()
    let soltar!: () => void
    const stripe = new Promise<void>(r => (soltar = r))
    captureSpy.mockImplementation(async (_m: any, p: any) => {
      await stripe
      return cobrada(p)
    })
    const apertura = abrir(a.orderId)
    await hastaQue(async () => (await cargo(a.charge.id)).status === 'CAPTURING')
    const durante = await listFolios({ venueId: venueId! })
    expect(durante.tarjetasPorAbrir.find(t => t.orderId === a.orderId)).toMatchObject({ cobrando: true })
    expect(durante.pollSeconds).toBe(30)
    soltar()
    await expect(apertura).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    const despues = await listFolios({ venueId: venueId! })
    expect(despues.tarjetasPorAbrir.map(t => t.orderId)).not.toContain(a.orderId)
    expect(despues.toDeliver.map(f => f.orderId)).toContain(a.orderId)
  })

  it('D661 · matriz: corte después del commit de confirmar y antes de avisar: la caja lo ve igual en su siguiente lectura (tarjetasPorAbrir)', async () => {
    // El aviso en vivo se pierde (el socket truena justo después del commit): la caja no depende de él, lee el estado.
    const aviso = socketManager.broadcastToVenue as jest.Mock
    aviso.mockClear()
    aviso.mockImplementationOnce(() => {
      throw new Error('el proceso murió antes de avisar')
    })
    const a = await apartado()
    expect(aviso.mock.results[0]?.type).toBe('throw') // el aviso de la confirmación se perdió
    const caja = await listFolios({ venueId: venueId! })
    expect(caja.tarjetasPorAbrir.map(t => t.orderId)).toContain(a.orderId)
    expect(caja.pollSeconds).toBe(30)
  })

  it('Ruling 7: con la respuesta vacía y la espera larga, prender la tarjeta desde el panel y crear el primer borrador sin que la caja vuelva a sondear NO ofrece la tarjeta; en cuanto una caja capaz recibe su primera respuesta rápida, sí', async () => {
    __resetCardAlertPollDebounceForTests()
    __resetPresenceDebounceForTests()
    await sinNadaVivo()
    // La tienda apagada y sin nada vivo; ninguna caja ha avisado nunca.
    const hhmm = (ms: number) => formatInTimeZone(new Date(Date.now() + ms), TZ, 'HH:mm')
    const dia = { enabled: true, ranges: [{ open: hhmm(-60 * MIN), close: hhmm(3 * 60 * MIN) }] }
    const HORARIO = { monday: dia, tuesday: dia, wednesday: dia, thursday: dia, friday: dia, saturday: dia, sunday: dia }
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: {
        enabled: false,
        requiresAcceptance: false,
        cardOnlineNadie: false,
        hours: HORARIO,
        lastToPayPollAt: null,
        lastCardAlertPollAt: null,
        cardAlertFastPollAt: null,
      },
    })
    const ajustes = () => prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })

    // 1) La caja capaz consulta y recibe la respuesta vacía con la espera larga: late «puedo avisar» (lento), no «a tiempo».
    const primera = await sondeo()
    expect(primera).toMatchObject({ showTile: false, pollSeconds: 600, tarjetasPorAbrir: [] })
    expect(await ajustes()).toMatchObject({ lastCardAlertPollAt: expect.any(Date), cardAlertFastPollAt: null })

    // 2) Desde el panel: tienda encendida en «Nadie» y la tarjeta prendida (lo permite el sondeo lento: visto en 7 días).
    await updateSettings(venueId!, { enabled: true, cardOnlineNadie: true }, staffId!)
    expect(await ajustes()).toMatchObject({ enabled: true, requiresAcceptance: false, cardOnlineNadie: true })

    // 3) El primer borrador, sin que la caja haya vuelto a sondear: NO se ofrece la tarjeta (nadie oiría el aviso a tiempo).
    await expect(borrador()).rejects.toMatchObject({ code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    expect(await prisma.onlineOrderCharge.count({ where: { venueId: venueId!, status: 'PENDING_AUTH' } })).toBe(0)

    // 4) La caja vuelve a consultar: ya recibe la cadencia rápida y lo escribe; desde ahí la tarjeta se ofrece.
    const segunda = await sondeo()
    expect(segunda.pollSeconds).toBe(30)
    expect((await ajustes()).cardAlertFastPollAt).toEqual(expect.any(Date))
    const d = await borrador()
    expect(d.trackingToken).toEqual(expect.any(String))
  })

  it('Ruling 7: el latido de la caja que avisa sólo lo escribe quien manda la cabecera; sin ella, nada (y la tarjeta no se ofrece)', async () => {
    __resetCardAlertPollDebounceForTests()
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { lastCardAlertPollAt: null, cardAlertFastPollAt: null },
    })
    const caja = await sondeo({ 'x-online-orders-to-pay': '1' }) // una caja vieja: cobra folios, no sabe avisar
    expect(caja.pollSeconds).toBe(30)
    expect(await prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })).toMatchObject({
      lastCardAlertPollAt: null,
      cardAlertFastPollAt: null,
    })
    await expect(borrador()).rejects.toMatchObject({ code: 'CARD_PAYMENT_NOT_ACCEPTED' })
  })

  it('D661 (Ruling 2): lo cobrado con la comanda pendiente sale en comandasPorImprimir —también cuando el cierre del día ya lo pasó a COMPLETED—, el reclamo lo admite y, con el papel confirmado, sale de la lista', async () => {
    await sinNadaVivo()
    const a = await cobrado()
    expect(await comandas()).toContain(a.orderId)

    // El cierre del día (04:00 del negocio) lo saca de «Por entregar»; su comanda sigue pendiente.
    await cerrarFoliosDelDiaTerminado({ venueId: venueId! }, () => new Date(Date.now() + 26 * 60 * MIN))
    expect((await enLinea(a.orderId)).status).toBe('COMPLETED')
    const caja = await listFolios({ venueId: venueId! })
    expect(caja.toDeliver.map(f => f.orderId)).not.toContain(a.orderId)
    expect(caja.comandasPorImprimir).toContainEqual({ orderId: a.orderId, orderNumber: (await cuenta(a.orderId)).orderNumber })

    // Ruling 14: la caja lee ESE pedido por su propio camino (POS y TPV) y trae sus renglones para imprimir.
    for (const namespace of ['m', 't'] as const) {
      const leido = await leerPedido(namespace, a.orderId)
      expect({ namespace, status: leido.status }).toEqual({ namespace, status: 200 })
      expect(leido.body.data).toMatchObject({ orderId: a.orderId, status: 'COMPLETED', needsPrint: true })
      expect(leido.body.data.items).toEqual([expect.objectContaining({ productId, name: 'Orden grande', quantity: 1 })])
    }

    // Una caja la reclama: mientras su reclamo está vigente nadie más la ve; al confirmar el papel, ya no vuelve.
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-1')).resolves.toEqual({ claimed: true })
    expect(await comandas()).not.toContain(a.orderId)
    await expect(confirmOnlineOrderPrinted(venueId!, a.orderId, 'caja-1')).resolves.toEqual({ ok: true })
    expect(await comandas()).not.toContain(a.orderId)
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-2')).resolves.toEqual({ claimed: false })
  })

  it('D661 (Ruling 2): con la devolución reservada (refundRequestedAt) o hecha (refundedAt) no sale en comandasPorImprimir, el reclamo no la admite y needsPrint es false', async () => {
    await sinNadaVivo()
    for (const marca of ['refundRequestedAt', 'refundedAt'] as const) {
      const a = await cobrado()
      await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { [marca]: new Date() } })
      const caja = await listFolios({ venueId: venueId! })
      expect({ marca, enLista: caja.comandasPorImprimir.some(c => c.orderId === a.orderId) }).toEqual({ marca, enLista: false })
      expect({ marca, needsPrint: caja.toDeliver.find(f => f.orderId === a.orderId)?.needsPrint }).toEqual({ marca, needsPrint: false })
      await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-1')).resolves.toEqual({ claimed: false })
    }
  })

  it('Ruling 9: un reclamo concedido sobre uno anterior que venció sin confirmarse trae posibleRepetida:true; dos cajas a la vez: una sola gana', async () => {
    await sinNadaVivo()
    const a = await cobrado()
    // Dos cajas reclaman la misma comanda a la vez: el CAS de Postgres deja pasar a una.
    const [x, y] = await Promise.all([
      claimOnlineOrderPrint(venueId!, a.orderId, 'caja-1'),
      claimOnlineOrderPrint(venueId!, a.orderId, 'caja-2'),
    ])
    expect([x.claimed, y.claimed].sort()).toEqual([false, true])
    expect(x.posibleRepetida ?? y.posibleRepetida).toBeUndefined()
    // El que ganó no confirmó (se cayó la impresora o el aparato): su reclamo vence y vuelve a la lista.
    const vencido = new Date(Date.now() - 2 * MIN)
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { printClaimedAt: vencido } })
    expect(await comandas()).toContain(a.orderId)
    // D661 · F1 (Ruling 37): una caja con la app VIEJA (no manda la cabecera ni marca «POSIBLE REPETIDA») no lo reclama: nada escrito.
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-vieja')).resolves.toEqual({ claimed: false })
    expect(await enLinea(a.orderId)).toMatchObject({ printClaimedAt: vencido, printedAt: null })
    expect((await enLinea(a.orderId)).printClaimedBy).not.toBe('caja-vieja')
    // Una caja actualizada (x-online-orders-card-alert: 1) sí, marcada como posible repetida.
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-3', new Date(), true)).resolves.toEqual({
      claimed: true,
      posibleRepetida: true,
    })
    await expect(confirmOnlineOrderPrinted(venueId!, a.orderId, 'caja-3')).resolves.toEqual({ ok: true })
    expect((await enLinea(a.orderId)).printClaimedBy).toBe('caja-3')
  })

  // ── Ola final (20-nov) ──────────────────────────────────────────────────────────────────────────────────────────────────────

  it('D661 · B1: la caja que pasa de 30 s a 600 s ya no hace que la tienda ofrezca la tarjeta; si vuelve a «Nadie», la tarjeta espera la siguiente respuesta rápida', async () => {
    __resetCardAlertPollDebounceForTests()
    await sinNadaVivo()
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { lastCardAlertPollAt: null, cardAlertFastPollAt: null },
    })
    const ajustes = () => prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })

    // 1) La única caja recibe 30 s con la tienda en «Nadie».
    expect((await sondeo()).pollSeconds).toBe(30)
    expect((await ajustes()).cardAlertFastPollAt).toEqual(expect.any(Date))
    // 2) La tienda pasa a «Mi equipo» sin nada vivo; segundos después la caja recibe 600 s: desde ahí duerme 10 min.
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: true } })
    expect((await sondeo()).pollSeconds).toBe(600)
    expect(await ajustes()).toMatchObject({ cardAlertFastPollAt: null, lastCardAlertPollAt: expect.any(Date) })
    // 3) Vuelve a «Nadie» dentro de los 90 s de aquel sondeo rápido: sin caja que oiga a tiempo, no se aparta el dinero de nadie.
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: false } })
    await expect(borrador()).rejects.toMatchObject({ code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    // 4) La siguiente respuesta rápida (sin esperar el amortiguado de la primera) vuelve a ofrecerla.
    expect((await sondeo()).pollSeconds).toBe(30)
    expect((await ajustes()).cardAlertFastPollAt).toEqual(expect.any(Date))
    await expect(borrador()).resolves.toMatchObject({ trackingToken: expect.any(String) })
  })

  it('D661 · B2 (Ruling 31): un «No lo recogió» pide su comanda sólo 2 h tras el corte: dentro, la lista, el reclamo y needsPrint lo admiten; fuera, ninguno', async () => {
    await sinNadaVivo()
    const dentro = await cobrado()
    const fuera = await cobrado()
    for (const [p, hace] of [
      [dentro, 2 * 60 * MIN - MIN],
      [fuera, 2 * 60 * MIN + MIN],
    ] as const) {
      const corte = new Date(Date.now() - hace)
      await prisma.onlineOrder.update({
        where: { id: p.onlineOrderId },
        data: { status: 'COMPLETED', completedAt: corte, notPickedUpAt: corte },
      })
    }
    const lista = await comandas()
    expect(lista).toContain(dentro.orderId)
    expect(lista).not.toContain(fuera.orderId)
    expect((await leerPedido('m', dentro.orderId)).body.data).toMatchObject({ needsPrint: true })
    expect((await leerPedido('m', fuera.orderId)).body.data).toMatchObject({ needsPrint: false })
    await expect(claimOnlineOrderPrint(venueId!, fuera.orderId, 'caja-1')).resolves.toEqual({ claimed: false })
    await expect(claimOnlineOrderPrint(venueId!, dentro.orderId, 'caja-1')).resolves.toEqual({ claimed: true })
  })

  it('D661 · B4: un apartado cuyo plazo ya pasó deja de sonar en seguida, antes de que lo cierre el trabajo de vencimiento; el que una caja está cobrando sigue en la lista aunque su plazo pase', async () => {
    await sinNadaVivo()
    const vencido = await apartado()
    const cobrando = await apartado()
    const vigente = await apartado()
    await prisma.onlineOrderCharge.update({ where: { id: cobrando.charge.id }, data: { status: 'CAPTURING' } })
    await prisma.onlineOrder.updateMany({
      where: { id: { in: [vencido.onlineOrderId, cobrando.onlineOrderId] } },
      data: { acceptDeadlineAt: new Date(Date.now() - 1000) },
    })
    const caja = await listFolios({ venueId: venueId! })
    expect(caja.tarjetasPorAbrir.map(t => t.orderId).sort()).toEqual([cobrando.orderId, vigente.orderId].sort())
    expect(caja.tarjetasPorAbrir.find(t => t.orderId === cobrando.orderId)).toMatchObject({ cobrando: true })
    // El vencido sigue PENDING_ACCEPTANCE hasta que pase el trabajo: no se cerró por leer la lista, sólo dejó de sonar.
    expect((await enLinea(vencido.orderId)).status).toBe('PENDING_ACCEPTANCE')
    await prisma.onlineOrderCharge.update({ where: { id: cobrando.charge.id }, data: { status: 'AUTHORIZED' } })
  })

  // ── Ronda codex-r2 (20-nov) ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('D661 · A (Ruling 41): 30 → 600 con la base fallando SÓLO al apagar la marca rápida: la caja que avisa recibe 30 s (no se duerme) mientras la tienda puede ofrecer la tarjeta; anotada la lenta, 600', async () => {
    __resetCardAlertPollDebounceForTests()
    await sinNadaVivo()
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { lastCardAlertPollAt: null, cardAlertFastPollAt: null },
    })
    const ajustes = () => prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })

    // 1) La única caja recibe 30 s con la tienda en «Nadie»: la marca rápida queda puesta.
    expect((await sondeo()).pollSeconds).toBe(30)
    const marca = (await ajustes()).cardAlertFastPollAt
    expect(marca).toEqual(expect.any(Date))
    // 2) La tienda pasa a «Mi equipo» sin nada vivo; en el siguiente sondeo la base falla SÓLO en la escritura que apaga la marca.
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: true } })
    const escribir = prisma.onlineOrderingSettings.updateMany.bind(prisma.onlineOrderingSettings)
    const espia = jest.spyOn(prisma.onlineOrderingSettings, 'updateMany').mockImplementation((async (a: any) => {
      if (a?.data?.cardAlertFastPollAt === null) throw new Error('se cayó la base al apagar la marca rápida')
      return escribir(a)
    }) as never)
    let lenta: any
    try {
      lenta = await sondeo()
    } finally {
      espia.mockRestore()
    }
    // La lista sería «lenta», pero la caja sigue en 30 s: la marca rápida sigue viva y la tienda todavía puede ofrecer la tarjeta.
    expect(lenta.pollSeconds).toBe(30)
    expect((await ajustes()).cardAlertFastPollAt).toEqual(marca)
    // 3) Vuelve a «Nadie» dentro de los 90 s: la tarjeta se ofrece y la caja la oye a tiempo (sondea cada 30 s).
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: false } })
    const d = await borrador()
    expect(d.trackingToken).toEqual(expect.any(String))
    // 4) Sin borradores vivos y de nuevo en «Mi equipo», con la base sana: la lenta se anota, la marca se apaga y entonces sí 600.
    await prisma.onlineOrderCharge.updateMany({ where: { venueId: venueId!, status: 'PENDING_AUTH' }, data: { status: 'ABANDONED' } })
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: true } })
    expect((await sondeo()).pollSeconds).toBe(600)
    expect((await ajustes()).cardAlertFastPollAt).toBeNull()
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: false } })
  })

  // ── Ronda codex-r3 (21-nov) ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('D661 · A (Ruling 72): la única caja recibe la respuesta lenta MIENTRAS se cotiza un borrador de «Nadie» → no nace (400 CARD_PAYMENT_NOT_ACCEPTED, nada escrito); con la caja otra vez a tiempo, sí', async () => {
    __resetCardAlertPollDebounceForTests()
    await sinNadaVivo()
    const ajustes = () => prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })
    expect((await sondeo()).pollSeconds).toBe(30) // la marca rápida, puesta: la tienda ofrece la tarjeta
    const cotizar = cotizacion.quoteCart
    const pausa = jest.spyOn(cotizacion, 'quoteCart').mockImplementationOnce(async (...a: Parameters<typeof cotizacion.quoteCart>) => {
      // El POST ya pasó su revisión de la caja. Un momento en «Mi equipo»: la única caja sondea, recibe 600 s y apaga su marca rápida.
      await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: true } })
      expect((await sondeo()).pollSeconds).toBe(600)
      await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: false } })
      return cotizar(...a)
    })
    checkoutSpy.mockClear()
    const antes = await prisma.onlineOrderCharge.count({ where: { venueId: venueId! } })
    try {
      await expect(borrador()).rejects.toMatchObject({ statusCode: 400, code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    } finally {
      pausa.mockRestore()
    }
    expect(await prisma.onlineOrderCharge.count({ where: { venueId: venueId! } })).toBe(antes)
    expect(checkoutSpy).not.toHaveBeenCalled()
    expect((await ajustes()).cardAlertFastPollAt).toBeNull()
    // La caja vuelve a sondear con la tienda en «Nadie»: 30 s, la marca regresa y el borrador sí nace.
    expect((await sondeo()).pollSeconds).toBe(30)
    await expect(borrador()).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', replay: false })
  })

  it('D661 · A (Ruling 79): la caja que avisó y después sondea SIN la cabecera (WINDOWS sin foco, la TPV cobrando) recibe 600 → la marca se apaga sin anotar latido: /info y el borrador (también su relectura del Ruling 72) ya no ofrecen la tarjeta; sin la cabecera y en 30 s, nada cambia; si no se pudo apagar, 30 s', async () => {
    __resetCardAlertPollDebounceForTests()
    await sinNadaVivo()
    // Sin borradores vivos: con la tienda apagada la lista es «lenta» (un borrador de «Nadie» vivo la mantiene en 30 s).
    await prisma.onlineOrderCharge.updateMany({ where: { venueId: venueId!, status: 'PENDING_AUTH' }, data: { status: 'ABANDONED' } })
    const ajustes = () => prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })
    /** Lo que contesta `/info` (`onlineOrdering.public.controller.ts`): el mismo predicado con los ajustes de hoy. */
    const ofrece = async () => cardOnlineAvailable(await ajustes(), prisma, venueId!)
    const tienda = (enabled: boolean) => prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { enabled } })
    const SIN_CABECERA = { 'x-online-orders-to-pay': '1' } // la MISMA caja, en un momento en que no manda la de la caja que avisa

    // 1) La caja avisa en 30 s: la marca queda puesta y la tienda ofrece la tarjeta.
    expect((await sondeo()).pollSeconds).toBe(30)
    const { cardAlertFastPollAt: marca, lastCardAlertPollAt: latido } = await ajustes()
    expect(marca).toEqual(expect.any(Date))
    expect(await ofrece()).toBe(true)

    // 2) Sin la cabecera y con la tienda en «Nadie» (respuesta de 30 s): nada cambia.
    expect((await sondeo(SIN_CABECERA)).pollSeconds).toBe(30)
    expect(await ajustes()).toMatchObject({ cardAlertFastPollAt: marca, lastCardAlertPollAt: latido })
    expect(await ofrece()).toBe(true)

    // 3) Un borrador ya pasó su primera revisión. El dueño apaga la tienda, la caja sondea SIN la cabecera y recibe 600 (se duerme),
    //    y el dueño la vuelve a prender dentro de los 90 s de la marca.
    const cotizar = cotizacion.quoteCart
    const pausa = jest.spyOn(cotizacion, 'quoteCart').mockImplementationOnce(async (...a: Parameters<typeof cotizacion.quoteCart>) => {
      await tienda(false)
      expect((await sondeo(SIN_CABECERA)).pollSeconds).toBe(600)
      await tienda(true)
      return cotizar(...a)
    })
    checkoutSpy.mockClear()
    const antes = await prisma.onlineOrderCharge.count({ where: { venueId: venueId! } })
    try {
      await expect(borrador()).rejects.toMatchObject({ statusCode: 400, code: 'CARD_PAYMENT_NOT_ACCEPTED' })
    } finally {
      pausa.mockRestore()
    }
    expect(await prisma.onlineOrderCharge.count({ where: { venueId: venueId! } })).toBe(antes)
    expect(checkoutSpy).not.toHaveBeenCalled()
    // La marca se apagó SIN anotar que una caja que avisa sondeó; /info y la admisión ya no ofrecen la tarjeta.
    expect(await ajustes()).toMatchObject({ cardAlertFastPollAt: null, lastCardAlertPollAt: latido })
    expect(await ofrece()).toBe(false)
    await expect(borrador()).rejects.toMatchObject({ code: 'CARD_PAYMENT_NOT_ACCEPTED' })

    // 4) La caja vuelve a avisar en 30 s: la tarjeta regresa en seguida. Con la tienda apagada, la lenta SIN la cabecera cuya escritura
    //    falla contesta 30 s y la marca sigue.
    expect((await sondeo()).pollSeconds).toBe(30)
    expect(await ofrece()).toBe(true)
    const marca2 = (await ajustes()).cardAlertFastPollAt
    await tienda(false)
    const escribir = prisma.onlineOrderingSettings.updateMany.bind(prisma.onlineOrderingSettings)
    const espia = jest.spyOn(prisma.onlineOrderingSettings, 'updateMany').mockImplementation((async (a: any) => {
      if (a?.data?.cardAlertFastPollAt === null) throw new Error('se cayó la base al apagar la marca rápida')
      return escribir(a)
    }) as never)
    let lenta: any
    try {
      lenta = await sondeo(SIN_CABECERA)
    } finally {
      espia.mockRestore()
      await tienda(true)
    }
    expect(lenta.pollSeconds).toBe(30)
    expect((await ajustes()).cardAlertFastPollAt).toEqual(marca2)
  })

  it('D661 · E (Ruling 40): sin la cabecera, la caja vieja que tenía el reclamo vencido lo repite (posibleRepetida:true); otra caja vieja, no; con la cabecera, como hoy', async () => {
    await sinNadaVivo()
    const a = await cobrado()
    // Una caja actualizada SIN impresora avisó y abrió el pedido. La caja VIEJA con la única impresora (USB) gana el primer reclamo y
    // pierde la respuesta antes de imprimir: su reclamo vence sin confirmarse.
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-vieja-A')).resolves.toEqual({ claimed: true })
    const vencido = new Date(Date.now() - 2 * MIN)
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { printClaimedAt: vencido } })

    // Otra caja vieja (sin la cabecera) NO repite el reclamo de A: nada escrito (Codex ANDROID #3 sigue negado).
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-vieja-B')).resolves.toEqual({ claimed: false })
    expect(await enLinea(a.orderId)).toMatchObject({ printClaimedAt: vencido, printClaimedBy: 'caja-vieja-A', printedAt: null })

    // La MISMA caja A, sin la cabecera, sí recupera su comanda: el pedido pagado no se queda sin papel.
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-vieja-A')).resolves.toEqual({ claimed: true, posibleRepetida: true })
    const suyo = await enLinea(a.orderId)
    expect(suyo.printClaimedBy).toBe('caja-vieja-A')
    expect(suyo.printClaimedAt!.getTime()).toBeGreaterThan(vencido.getTime())
    // Mientras ese reclamo vive, nadie lo repite (tampoco ella misma).
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-vieja-A')).resolves.toEqual({ claimed: false })

    // Vence otra vez: una caja actualizada (con la cabecera) lo repite como hoy, y sólo ella confirma el papel.
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { printClaimedAt: vencido } })
    await expect(claimOnlineOrderPrint(venueId!, a.orderId, 'caja-nueva', new Date(), true)).resolves.toEqual({
      claimed: true,
      posibleRepetida: true,
    })
    await expect(confirmOnlineOrderPrinted(venueId!, a.orderId, 'caja-vieja-A')).resolves.toEqual({ ok: false })
    await expect(confirmOnlineOrderPrinted(venueId!, a.orderId, 'caja-nueva')).resolves.toEqual({ ok: true })
  })
})
