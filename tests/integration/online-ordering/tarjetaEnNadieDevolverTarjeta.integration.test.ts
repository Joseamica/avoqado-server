// tests/integration/online-ordering/tarjetaEnNadieDevolverTarjeta.integration.test.ts
/**
 * Integration (REAL DB) — D661 tarea 5: «Cancelar y devolver» a la tarjeta en «Nadie». Lo que los dobles no prueban: la reserva
 * (`refundRequestedAt`) escrita bajo el candado de la orden ANTES de Stripe y su carrera real contra «Entregado»; el cierre «Devuelto»
 * (`COMPLETED` + `refundedAt`) que nada revive; el estado terminal de un intento fallido y el retiro de su reserva en UNA transacción
 * (con su rollback real); el barrido que cierra lo que quedó anotado sin cerrar, también una fila RESOLVED que el calendario ya no
 * visita; y la cocina: con la reserva no se arma comanda nueva, no se reclama papel ni se marca «Listo», y si la devolución falla la
 * cocina retoma con UNA comanda. Stripe es un doble siempre. Un «corte» deja confirmado el paso anterior, hace tronar el siguiente
 * DENTRO del paso que se corta y corre la siguiente pasada como una llamada nueva. Todo se acota a la sucursal de esta prueba.
 */
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { sendVenueNotification } from '@/services/dashboard/notification.dashboard.service'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import {
  NEVER_AGAIN,
  advanceCardRefund,
  advanceCardRefundForSweep,
  listCardRefunds,
  refundCardOnlineOrder,
} from '@/services/online-ordering/card/refund.service'
import { cerrarDevueltosPendientes } from '@/services/online-ordering/card/refund-reconciler.service'
import { cerrarComoDevueltoEnTx } from '@/services/online-ordering/card/devuelto'
import { cerrarFoliosDelDiaTerminado, listFolios, syncPaidClosedFolios } from '@/services/online-ordering/folios.service'
import { getInboxOrder, listInbox } from '@/services/online-ordering/inbox.service'
import { claimOnlineOrderPrint, confirmOnlineOrderPrinted } from '@/services/online-ordering/printClaim.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { getTrackingByToken } from '@/services/online-ordering/order.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByStaff,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
} from '@/services/online-ordering/transitions.service'
import { authorKitchenTickets } from '@/services/kds/kitchenTicketAuthoring.service'
import { KitchenTicketsReconciliationJob } from '@/jobs/kitchen-tickets-reconciliation.job'
import { enqueueRefundPaymentEffectsInTx } from '@/services/tpv/paymentEffects.service'
import mobileRouter from '@/routes/mobile/onlineOrders.mobile.routes'

// El guardia global rechaza `av-db-25` y hosts remotos; esta suite exige además una base desechable o la propia de la fase.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(avoqado_[a-z0-9_]+_test_[a-z0-9_]+|av-db-25-[a-z0-9-]+)$/.test(database.pathname)
) {
  throw new Error('Esta suite sólo corre contra una base desechable (avoqado_<tarea>_test_<fecha> o av-db-25-<fase>) en localhost.')
}

// La sesión de la caja (el JWT) la dan las cabeceras de la prueba; el permiso y la sucursal se resuelven de verdad en la base.
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
// La comanda de pantalla NO se arma sola tras el cobro: la arma el armado real cuando la prueba lo llama (o el barrido de cocina).
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/receipt.dashboard.service'),
  generateAndStoreReceipt: jest.fn(async () => undefined),
}))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/notification.dashboard.service'),
  sendVenueNotification: jest.fn(async () => []),
}))
// El cierre «Devuelto» y el encolado de comisiones son los REALES; envueltos sólo para poder cortar dentro de ellos y contarlos.
jest.mock('@/services/online-ordering/card/devuelto', () => {
  const real = jest.requireActual('@/services/online-ordering/card/devuelto')
  return { ...real, cerrarComoDevueltoEnTx: jest.fn(real.cerrarComoDevueltoEnTx) }
})
jest.mock('@/services/tpv/paymentEffects.service', () => {
  const real = jest.requireActual('@/services/tpv/paymentEffects.service')
  return { ...real, enqueueRefundPaymentEffectsInTx: jest.fn(real.enqueueRefundPaymentEffectsInTx) }
})

jest.setTimeout(90_000)

const RUN = Date.now()
const MIN = 60_000
const TZ = 'America/Mexico_City'
const PUEDE_CREAR = { assertCanCreate: async () => {} }
/** El último corte del día del negocio (04:00 en su zona) que ya pasó; con un texto, nunca con la zona de la máquina. */
const ultimoCorte = () => fromZonedTime(`${formatInTimeZone(new Date(Date.now() - 4 * 60 * MIN), TZ, 'yyyy-MM-dd')}T04:00:00.000`, TZ)
const enUnRato = (ms: number) => new Date(Date.now() + ms)

describe('D661 · tarea 5: «Cancelar y devolver» a la tarjeta en «Nadie» (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let productId: string
  const clientas: string[] = []
  let turno = 0
  let seq = 0
  const llave = () => `dev-${RUN}-${++seq}-`.padEnd(40, 'x')

  // ── Stripe, siempre un doble ──────────────────────────────────────────────────────────────────────────────────────────────────
  const sesiones = new Map<string, { id: string; url: string; expiresAt: Date }>()
  let checkoutSpy: jest.SpyInstance
  let authSpy: jest.SpyInstance
  let captureSpy: jest.SpyInstance
  let voidSpy: jest.SpyInstance
  let refundSpy: jest.SpyInstance
  let getRefundSpy: jest.SpyInstance
  let listRefundsSpy: jest.SpyInstance
  let feeSpy: jest.SpyInstance
  /** D661 (Task 6, Ruling 28): la lectura del cargo antes de devolver; contesta con lo que este doble de Stripe tiene. */
  let chargeRefundsSpy: jest.SpyInstance
  let piSeq = 0
  type EnStripe = {
    refundId: string
    amount: number
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'
    metadata: Record<string, string>
    pi: string
  }
  /** Las devoluciones que Stripe tiene, por su llave idempotente (la misma llave devuelve la misma). */
  const enStripe = new Map<string, EnStripe>()
  /** Cómo nace la siguiente devolución en Stripe. */
  let estadoNuevo: EnStripe['status'] = 'SUCCEEDED'
  const stripeDevuelve = async (_m: unknown, p: any) => {
    if (!enStripe.has(p.idempotencyKey)) {
      enStripe.set(p.idempotencyKey, {
        refundId: `re_dev_${RUN}_${enStripe.size + 1}`,
        amount: p.amount,
        status: estadoNuevo,
        metadata: p.metadata,
        pi: p.paymentIntentId,
      })
    }
    const d = enStripe.get(p.idempotencyKey)!
    return { refundId: d.refundId, amount: d.amount, status: d.status }
  }
  /** Stripe cambia el estado de la devolución de ESTA fila (su aviso, o lo que contesta al releerla). */
  const stripeDice = (cardRefundId: string, status: EnStripe['status']) => {
    const d = [...enStripe.values()].find(x => x.metadata?.cardRefundId === cardRefundId)
    if (!d) throw new Error(`Stripe no tiene la devolución de ${cardRefundId}`)
    d.status = status
  }
  const autorizada = (authorizedAt: Date, paymentIntentId = `pi_dev_${RUN}_${++piSeq}`) => ({
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

  // ── Lecturas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const enLinea = (orderId: string) => prisma.onlineOrder.findFirstOrThrow({ where: { orderId } })
  const cuenta = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const fila = (id: string) => prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id } })
  const filasDe = (chargeId: string) => prisma.onlineOrderCardRefund.count({ where: { venueId: venueId!, chargeId } })
  const refundsOf = (orderId: string) =>
    prisma.payment.findMany({ where: { orderId, type: 'REFUND' }, orderBy: { createdAt: 'asc' }, take: 10 })
  const cierres = (onlineOrderId: string) =>
    prisma.activityLog.count({ where: { venueId: venueId!, entityId: onlineOrderId, action: 'ONLINE_ORDER_CLOSED_AS_REFUNDED' } })
  const comandasDe = (orderId: string) => prisma.kdsOrder.count({ where: { venueId: venueId!, orderId } })

  // ── Pedidos ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Un apartado de «Nadie» de una clienta con sesión: borrador + autorización de Stripe hace un minuto. */
  const apartado = async () => {
    const d = await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-devolver-${RUN}`,
        idempotencyKey: llave(),
        items: [{ productId, quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'Ana Nadie', email: 'ana@test.com' },
        customerId: clientas[turno++ % clientas.length],
        verifiedPhone: null,
      },
      PUEDE_CREAR,
    )
    const c0 = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { trackingToken: d.trackingToken } })
    authSpy.mockResolvedValueOnce(autorizada(new Date(Date.now() - MIN)))
    await expect(confirmCardAuthorization(c0.id)).resolves.toBe('CREATED')
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: c0.id } })
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c.onlineOrderId! } })
    return { chargeId: c.id, orderId: oo.orderId, onlineOrderId: oo.id, trackingToken: d.trackingToken }
  }
  /** Un apartado que una caja ya abrió: cobrado, «Por entregar» y con la comanda de pantalla pendiente (sin armar). */
  const cobrado = async () => {
    const a = await apartado()
    await expect(
      acceptOnlineOrder({ venueId: venueId!, orderId: a.orderId, staffId: null, abrirPagadoEnLinea: true }),
    ).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    return a
  }
  /** «Cancelar y devolver» del panel: 100 % a la tarjeta, con la vista del operador al día. */
  const devolver = async (
    orderId: string,
    o: Partial<{ amount: string; key: string; expected: string | null; efectoEsperado: { cierraComoDevuelto: boolean } }> = {},
  ) =>
    refundCardOnlineOrder({
      venueId: venueId!,
      orderId,
      amount: new Prisma.Decimal(o.amount ?? '250.00'),
      reason: 'CANCELLED_ORDER',
      staffId: staffId!,
      idempotencyKey: o.key ?? llave(),
      note: null,
      expectedLatestRefundId: o.expected === undefined ? ((await listCardRefunds(venueId!, orderId))[0]?.id ?? null) : o.expected,
      destino: 'CARD',
      ...(o.efectoEsperado ? { efectoEsperado: o.efectoEsperado } : {}),
    })
  /** Lo cobrado quedó del día anterior (aceptado un minuto antes del último corte). */
  const deAyer = (onlineOrderId: string) =>
    prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { acceptedAt: new Date(ultimoCorte().getTime() - MIN) } })
  const corte = () => cerrarFoliosDelDiaTerminado({ venueId: venueId! }, () => new Date())

  /** Las rutas REALES de la caja (POS), con la sesión de la cajera de la sucursal. */
  const cajas = express()
  cajas.use(express.json())
  cajas.use('/m/venues/:venueId/online-orders', mobileRouter)
  cajas.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ code: err.code, error: err.message }))
  const porLaCaja = (accion: 'delivered' | 'ready', orderId: string) =>
    request(cajas)
      .post(`/m/venues/${venueId}/online-orders/${orderId}/${accion}`)
      .set('x-test-staff', staffId!)
      .set('x-test-venue', venueId!)
      .send({})

  /** El barrido de cocina REAL (el job), con su reloj y acotado a esta sucursal: nunca arma ni limpia cuentas de otras pruebas. */
  const cocina = (ahora: Date) =>
    new KitchenTicketsReconciliationJob({
      cron: { start: () => undefined, stop: () => undefined },
      now: () => ahora,
      prisma: {
        order: {
          findMany: (a: any) => prisma.order.findMany({ ...a, where: { ...a.where, venueId: venueId! } }),
          updateMany: (a: any) => prisma.order.updateMany(a),
        },
      } as any,
    })

  /**
   * Corta DENTRO de un paso de una transacción: envuelve TODA transacción con un cliente que truena en la PRIMERA escritura que
   * cumpla `cortar` (sin depender de qué transacción la consume). Devuelve con qué restaurar.
   */
  const cortarDentroDeLaTransaccion = (modelo: string, metodo: string, cortar: (args: any) => boolean, porque: string) => {
    const original = prisma.$transaction.bind(prisma) as any
    let cortado = false
    const envolver = (tx: any) =>
      new Proxy(tx, {
        get: (cliente, k) => {
          const valor = Reflect.get(cliente, k)
          if (k !== modelo) return typeof valor === 'function' ? valor.bind(cliente) : valor
          return new Proxy(valor, {
            get: (delegado, m) => {
              const f = Reflect.get(delegado, m)
              if (m !== metodo) return typeof f === 'function' ? f.bind(delegado) : f
              return async (args: any) => {
                if (!cortado && cortar(args)) {
                  cortado = true
                  throw new Error(porque)
                }
                return f.call(delegado, args)
              }
            },
          })
        },
      })
    const espia = jest
      .spyOn(prisma, '$transaction')
      .mockImplementation(((cuerpo: any, opciones?: any) =>
        typeof cuerpo === 'function' ? original((tx: any) => cuerpo(envolver(tx)), opciones) : original(cuerpo, opciones)) as any)
    return { restaurar: () => espia.mockRestore(), cortado: () => cortado }
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Devolver Org', slug: `itest-devolver-org-${RUN}`, email: `itest-devolver-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Devolver Venue',
        slug: `itest-devolver-${RUN}`,
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
      await prisma.staff.create({
        data: { email: `itest-devolver-caja-${RUN}@test.com`, firstName: 'Caja', lastName: 'ITEST', active: true },
      })
    ).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-devolver-${RUN}` } })
    // Un negocio con pantalla de cocina: el cobro deja la cocina pendiente y se puede contar la comanda que se arma.
    await prisma.printStation.create({
      data: {
        venueId,
        name: 'Cocina',
        isDefault: true,
        hasKitchenDisplay: true,
        kitchenDisplaySince: new Date(Date.now() - 24 * 3_600_000),
      },
    })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-devolver-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `DEVOLVER-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    for (let i = 0; i < 25; i++) {
      clientas.push(
        (await prisma.customer.create({ data: { venueId, email: `devolver${i}-${RUN}@test.com`, firstName: `Clienta ${i}` } })).id,
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
        businessName: 'ITEST Devolver',
        contactEmail: `itest-devolver-merchant-${RUN}@test.com`,
        publicKey: `pk_test_itest_devolver_${RUN}`,
        secretKeyHash: `itest-devolver-hash-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: 'acct_itest_devolver' },
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
    refundSpy = jest.spyOn(StripeConnectProvider.prototype, 'refund')
    getRefundSpy = jest.spyOn(StripeConnectProvider.prototype, 'getRefund')
    listRefundsSpy = jest.spyOn(StripeConnectProvider.prototype, 'listRefunds')
    feeSpy = jest.spyOn(StripeConnectProvider.prototype, 'getApplicationFeeRefundedCents')
    chargeRefundsSpy = jest.spyOn(StripeConnectProvider.prototype, 'getChargeRefunds')
  })

  beforeEach(async () => {
    checkoutSpy.mockReset()
    checkoutSpy.mockImplementation(async (_m: any, p: any) => {
      if (!sesiones.has(p.idempotencyKey)) {
        const id = `cs_itest_devolver_${RUN}_${sesiones.size + 1}`
        sesiones.set(p.idempotencyKey, { id, url: `https://checkout.stripe.test/${id}`, expiresAt: p.expiresAt })
      }
      return sesiones.get(p.idempotencyKey)!
    })
    authSpy.mockReset()
    captureSpy.mockReset()
    captureSpy.mockImplementation(async (_m: any, p: any) => ({
      sessionStatus: null,
      paymentIntentId: p.paymentIntentId,
      piStatus: 'succeeded',
      amountCapturableCents: 0,
      amountReceivedCents: p.amountCents,
      captureBefore: null,
      card: { brand: 'visa', last4: '4242', funding: 'credit' },
      paymentMethodType: 'card',
    }))
    voidSpy.mockReset()
    voidSpy.mockImplementation(async (_m: any, p: any) => ({
      ...autorizada(new Date(), p.paymentIntentId),
      piStatus: 'canceled',
      amountCapturableCents: 0,
    }))
    estadoNuevo = 'SUCCEEDED'
    refundSpy.mockReset()
    refundSpy.mockImplementation(stripeDevuelve)
    getRefundSpy.mockReset()
    getRefundSpy.mockImplementation(async (_m: any, id: string) => {
      const d = [...enStripe.values()].find(x => x.refundId === id)!
      return { refundId: id, status: d.status, amountCents: d.amount, failureReason: d.status === 'FAILED' ? 'declined' : null }
    })
    listRefundsSpy.mockReset()
    listRefundsSpy.mockImplementation(async (_m: any, pi: string) =>
      [...enStripe.values()]
        .filter(d => d.pi === pi)
        .map(d => ({ refundId: d.refundId, status: d.status, amountCents: d.amount, failureReason: null, metadata: d.metadata })),
    )
    feeSpy.mockReset()
    feeSpy.mockResolvedValue(0)
    chargeRefundsSpy.mockReset()
    chargeRefundsSpy.mockImplementation(async (_m: any, pi: string) => {
      const delCargo = [...enStripe.values()].filter(d => d.pi === pi)
      return {
        amountRefundedCents: delCargo.filter(d => d.status === 'PENDING' || d.status === 'SUCCEEDED').reduce((t, d) => t + d.amount, 0),
        refunds: delCargo.map(d => ({
          refundId: d.refundId,
          status: d.status,
          amountCents: d.amount,
          failureReason: null,
          metadata: d.metadata,
        })),
      }
    })
    ;(logAction as jest.Mock).mockClear()
    ;(sendVenueNotification as jest.Mock).mockClear()
    ;(cerrarComoDevueltoEnTx as jest.Mock).mockClear()
    ;(enqueueRefundPaymentEffectsInTx as jest.Mock).mockClear()
    // Lo de la prueba anterior de ESTA sucursal queda resuelto (con su comanda impresa y, si se devolvió, cerrado): sólo cuenta lo
    // de cada prueba, también para el barrido de cierres.
    await prisma.onlineOrderCharge.updateMany({ where: { venueId: venueId!, status: 'PENDING_AUTH' }, data: { status: 'ABANDONED' } })
    await prisma.onlineOrder.updateMany({ where: { venueId: venueId!, status: 'PENDING_ACCEPTANCE' }, data: { status: 'EXPIRED' } })
    await prisma.onlineOrder.updateMany({
      where: { venueId: venueId!, OR: [{ status: { in: ['ACCEPTED', 'READY'] } }, { status: 'COMPLETED', printedAt: null }] },
      data: { status: 'COMPLETED', printedAt: new Date() },
    })
    await prisma.onlineOrder.updateMany({
      where: {
        venueId: venueId!,
        refundedAt: null,
        OR: [{ refundRequestedAt: { not: null } }, { charge: { is: { cardRefunds: { some: {} } } } }],
      },
      data: { refundedAt: new Date() },
    })
    await prisma.order.updateMany({ where: { venueId: venueId!, kitchenPendingAt: { not: null } }, data: { kitchenPendingAt: null } })
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
    for (const s of [checkoutSpy, authSpy, captureSpy, voidSpy, refundSpy, getRefundSpy, listRefundsSpy, feeSpy, chargeRefundsSpy])
      s?.mockRestore()
    // Limpieza acotada: sin venueId NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!venueId) return
    const v = { venueId }
    await prisma.kdsOrderItem.deleteMany({ where: { kdsOrder: v } })
    await prisma.kdsOrder.deleteMany({ where: v })
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
    await prisma.moneyAnomaly.deleteMany({ where: { expectedState: { path: ['venueId'], equals: venueId } } })
    await prisma.activityLog.deleteMany({ where: v })
    await prisma.notification.deleteMany({ where: v })
    await prisma.paymentEffect.deleteMany({ where: v })
    await prisma.inventoryPosting.deleteMany({ where: v })
    await prisma.venueTransaction.deleteMany({ where: v })
    await prisma.payment.deleteMany({ where: { ...v, type: 'REFUND' } })
    await prisma.payment.deleteMany({ where: v })
    await prisma.onlineOrderCardRefundReversal.deleteMany({ where: v })
    await prisma.onlineOrderCardRefund.deleteMany({ where: v })
    await prisma.onlineOrderCharge.deleteMany({ where: v }) // antes del comercio (Restrict)
    await prisma.onlineOrder.deleteMany({ where: v })
    await prisma.order.deleteMany({ where: v })
    await prisma.ecommerceMerchant.deleteMany({ where: v })
    await prisma.product.deleteMany({ where: v })
    await prisma.menuCategory.deleteMany({ where: v })
    await prisma.printStation.deleteMany({ where: v })
    await prisma.customer.deleteMany({ where: v })
    await prisma.onlineOrderingSettings.deleteMany({ where: v })
    await prisma.privacyNoticeVersion.deleteMany({ where: v })
    await prisma.staffVenue.deleteMany({ where: v })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  // ── 100 % o nada ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('«Nadie»: parcial → 400 FULL_REFUND_ONLY; «Mi equipo» parcial sigue (su vecino vive en card-refund.integration.test.ts)', async () => {
    const p = await cobrado()
    await expect(devolver(p.orderId, { amount: '125.00' })).rejects.toMatchObject({ statusCode: 400, code: 'FULL_REFUND_ONLY' })
    expect(await filasDe(p.chargeId)).toBe(0)
    expect(refundSpy).not.toHaveBeenCalled()
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', refundRequestedAt: null, refundedAt: null })
  })

  // ── La reserva ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('reserva antes de Stripe; con la reserva, entregar → 409', async () => {
    const p = await cobrado()
    estadoNuevo = 'PENDING'
    let reservaAlLlamarAStripe: Date | null | undefined
    refundSpy.mockImplementationOnce(async (m: unknown, prm: any) => {
      reservaAlLlamarAStripe = (await enLinea(p.orderId)).refundRequestedAt
      return stripeDevuelve(m, prm)
    })
    const r = await devolver(p.orderId)
    expect(r).toMatchObject({ status: 'PENDING', cardRefundStatus: 'PENDING', replay: false })
    expect(reservaAlLlamarAStripe).toBeInstanceOf(Date)
    const { refundRequestedAt } = await enLinea(p.orderId)

    // Entregar: 409 por la ruta real con «Devolviendo…»; el servicio no escribe nada.
    const entrega = await porLaCaja('delivered', p.orderId)
    expect(entrega.status).toBe(409)
    expect(entrega.body).toMatchObject({
      code: 'ORDER_STATE_CHANGED',
      status: 'ACCEPTED',
      refundRequestedAt: refundRequestedAt!.toISOString(),
    })
    expect(entrega.body.error).toMatch(/se está devolviendo/)
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', completedAt: null })
    // La bandeja y el seguimiento dicen la verdad: «Devolviendo…» y la devolución pendiente a la tarjeta.
    expect(await getInboxOrder({ venueId: venueId!, orderId: p.orderId })).toMatchObject({
      refundRequestedAt: refundRequestedAt!.toISOString(),
      refundedAt: null,
      needsPrint: false,
    })
    expect((await getTrackingByToken(p.trackingToken))?.refund).toEqual({ status: 'PENDING', medio: 'TARJETA' })
  })

  it('carrera real: entregar vs reservar la devolución bajo el candado de la orden — gana una sola; nunca entregado y «Devolviendo…» a la vez', async () => {
    estadoNuevo = 'PENDING' // la reserva sigue viva tras pedir: así se ve si convivió con una entrega
    for (let i = 0; i < 6; i++) {
      const p = await cobrado()
      const [entrega, devolucion] = await Promise.allSettled([
        markOnlineOrderDelivered({ venueId: venueId!, orderId: p.orderId, staffId: staffId! }),
        devolver(p.orderId),
      ])
      expect(devolucion.status).toBe('fulfilled')
      const oo = await enLinea(p.orderId)
      expect({ i, entregadoYDevolviendo: oo.status === 'COMPLETED' && oo.refundRequestedAt !== null }).toEqual({
        i,
        entregadoYDevolviendo: false,
      })
      if (oo.status === 'COMPLETED') {
        // Ganó la entrega: la devolución corrió después sobre un pedido ya entregado, sin reserva.
        expect(entrega).toEqual({ status: 'fulfilled', value: { outcome: 'OK', status: 'COMPLETED' } })
      } else {
        // Ganó la reserva: la entrega contestó su estado real y no escribió nada.
        expect(oo).toMatchObject({ status: 'ACCEPTED', completedAt: null })
        expect(oo.refundRequestedAt).not.toBeNull()
        expect(entrega).toMatchObject({
          status: 'fulfilled',
          value: { outcome: 'STALE', status: 'ACCEPTED', refundRequestedAt: expect.any(String) },
        })
      }
    }
  })

  // ── El cierre «Devuelto» ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it('RECORDED → pedido COMPLETED con refundedAt; tras syncPaidClosedFolios y una lectura de la bandeja NO reaparece en «Por entregar»', async () => {
    const p = await cobrado()
    const r = await devolver(p.orderId)
    expect(r).toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RECORDED', replay: false })
    const oo = await enLinea(p.orderId)
    expect(oo).toMatchObject({ status: 'COMPLETED', notPickedUpAt: null })
    expect(oo.refundedAt).not.toBeNull()
    expect(oo.completedAt).toEqual(oo.refundedAt)
    // La venta queda como cualquier venta reembolsada (PAID con su renglón REFUND), sin cancelar nada; la cocina pendiente, limpia.
    expect(await cuenta(p.orderId)).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED', kitchenPendingAt: null })
    const ledger = await refundsOf(p.orderId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].amount.toFixed(2)).toBe('-250.00')
    expect(await cierres(p.onlineOrderId)).toBe(1)

    // Nada lo revive: la pasada de folios cerrados, la bandeja y la lista de la caja.
    await syncPaidClosedFolios({ venueId: venueId! }, () => new Date())
    await listInbox({ venueId: venueId!, filter: 'all' })
    const folios = await listFolios({ venueId: venueId! })
    expect(folios.toDeliver.map(o => o.orderId)).not.toContain(p.orderId)
    expect(folios.tarjetasPorAbrir.map(o => o.orderId)).not.toContain(p.orderId)
    expect(folios.comandasPorImprimir.map(o => o.orderId)).not.toContain(p.orderId)
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'COMPLETED', refundedAt: oo.refundedAt })
    expect(await getTrackingByToken(p.trackingToken)).toMatchObject({
      status: 'COMPLETED',
      refundedAt: oo.refundedAt!.toISOString(),
      refund: { status: 'DONE', medio: 'TARJETA' },
    })
  })

  it('muere entre RECORDED y el cierre: el barrido de refund-reconciler lo cierra; mientras, no se entrega ni lo marca el cierre del día', async () => {
    const p = await cobrado()
    await deAyer(p.onlineOrderId)
    ;(cerrarComoDevueltoEnTx as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('el proceso murió entre RECORDED y el cierre')
    })
    const r = await devolver(p.orderId)
    expect(r).toMatchObject({ status: 'RECORDED' })
    const reservado = await enLinea(p.orderId)
    expect(reservado).toMatchObject({ status: 'ACCEPTED', refundedAt: null })
    expect(reservado.refundRequestedAt).not.toBeNull()

    // Mientras tanto: no se entrega y el cierre del día no lo marca «No lo recogió».
    expect((await porLaCaja('delivered', p.orderId)).status).toBe(409)
    await expect(corte()).resolves.toBe(0)
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', notPickedUpAt: null, refundedAt: null })

    // El barrido lo cierra, una sola vez.
    await expect(cerrarDevueltosPendientes({ venueId: venueId! }, new Date())).resolves.toBe(1)
    const cerrado = await enLinea(p.orderId)
    expect(cerrado).toMatchObject({ status: 'COMPLETED', notPickedUpAt: null })
    expect(cerrado.refundedAt).not.toBeNull()
    expect(await cierres(p.onlineOrderId)).toBe(1)
    await expect(cerrarDevueltosPendientes({ venueId: venueId! }, new Date())).resolves.toBe(0)
    expect(await cierres(p.onlineOrderId)).toBe(1)
  })

  it('muere tras guardar la fila sin hablar con Stripe: el reconciliador termina devolución y cierre', async () => {
    const p = await cobrado()
    // «Morir» = el primer paso después del commit (releer la fila para avanzarla) truena: queda REQUESTED y Stripe no se llamó.
    const leer = prisma.onlineOrderCardRefund.findUnique.bind(prisma.onlineOrderCardRefund)
    let murio = false
    const espia = jest.spyOn(prisma.onlineOrderCardRefund, 'findUnique').mockImplementation((async (args: any) => {
      if (!murio && typeof args?.where?.id === 'string') {
        murio = true
        throw new Error('el proceso murió tras guardar la fila')
      }
      return leer(args)
    }) as never)
    let r: Awaited<ReturnType<typeof devolver>>
    try {
      r = await devolver(p.orderId)
    } finally {
      espia.mockRestore()
    }
    expect(murio).toBe(true)
    expect(r).toMatchObject({ status: 'UNKNOWN', cardRefundStatus: 'REQUESTED' })
    expect(refundSpy).not.toHaveBeenCalled()
    expect((await enLinea(p.orderId)).refundRequestedAt).not.toBeNull()

    // La siguiente pasada del reconciliador (su paso por esta fila) devuelve y cierra.
    await expect(advanceCardRefundForSweep(r.cardRefundId, new Date())).resolves.toMatchObject({ status: 'RECORDED' })
    expect(refundSpy).toHaveBeenCalledTimes(1)
    expect(await refundsOf(p.orderId)).toHaveLength(1)
    const oo = await enLinea(p.orderId)
    expect(oo.status).toBe('COMPLETED')
    expect(oo.refundedAt).not.toBeNull()
    expect(await cierres(p.onlineOrderId)).toBe(1)
  })

  // ── Falla: la reserva se retira y la cocina retoma ──────────────────────────────────────────────────────────────────────────

  it('FAILED → se quita la reserva, vuelve a entregable, con aviso', async () => {
    const p = await cobrado()
    estadoNuevo = 'FAILED'
    const r = await devolver(p.orderId)
    expect(r).toMatchObject({ status: 'FAILED', cardRefundStatus: 'FAILED', refundId: null })
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', refundRequestedAt: null, refundedAt: null })
    expect(await refundsOf(p.orderId)).toHaveLength(0)
    expect(sendVenueNotification).toHaveBeenCalledWith(
      venueId,
      expect.objectContaining({ entityId: r.cardRefundId, priority: 'HIGH' }),
      expect.any(Array),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUND_FAILED', entityId: r.cardRefundId }))
    // La cocina retoma: la marca vuelve a quedar puesta.
    expect((await cuenta(p.orderId)).kitchenPendingAt).not.toBeNull()
    // Sin devolución que contar en el seguimiento, y vuelve a entregable.
    expect(await getTrackingByToken(p.trackingToken)).not.toHaveProperty('refund')
    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })).resolves.toEqual({
      outcome: 'OK',
      status: 'COMPLETED',
    })
  })

  it.each(['FAILED', 'CANCELED'] as const)(
    'FAILED o CANCELED y el retiro de la reserva en una transacción: si muere después, no queda «Devolviendo…» para siempre (%s)',
    async desenlace => {
      const p = await cobrado()
      estadoNuevo = 'PENDING'
      const r = await devolver(p.orderId)
      expect(r.cardRefundStatus).toBe('PENDING')
      stripeDice(r.cardRefundId, desenlace)

      // (a) Muere DENTRO de la transacción del desenlace (al volver a dejar la cocina pendiente): se revierte TODO.
      const corte1 = cortarDentroDeLaTransaccion(
        'order',
        'updateMany',
        a => a?.data?.kitchenPendingAt instanceof Date,
        'el proceso murió dentro de la transacción del desenlace',
      )
      try {
        await expect(advanceCardRefund(r.cardRefundId)).rejects.toThrow('murió dentro de la transacción')
      } finally {
        corte1.restaurar()
      }
      expect(corte1.cortado()).toBe(true)
      expect((await fila(r.cardRefundId)).status).toBe('PENDING')
      expect((await enLinea(p.orderId)).refundRequestedAt).not.toBeNull()

      // (b) Confirma y muere DESPUÉS del commit, antes del aviso: el estado terminal y el retiro ya quedaron juntos.
      ;(sendVenueNotification as jest.Mock).mockImplementationOnce(() => {
        throw new Error('el proceso murió antes del aviso')
      })
      await expect(advanceCardRefund(r.cardRefundId)).rejects.toThrow('antes del aviso')
      expect((await fila(r.cardRefundId)).status).toBe(desenlace)
      expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', refundRequestedAt: null, refundedAt: null })
      expect((await cuenta(p.orderId)).kitchenPendingAt).not.toBeNull()

      // Otra pasada no repite nada.
      await expect(advanceCardRefund(r.cardRefundId)).resolves.toBe(desenlace)
      expect(await refundsOf(p.orderId)).toHaveLength(0)
    },
  )

  it('RECORDED → REVERSED antes del cierre: el barrido cierra igual (y tras una reversa que muere antes del aviso, la obligación de devolver por otro medio sigue visible)', async () => {
    const p = await cobrado()
    ;(cerrarComoDevueltoEnTx as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('el proceso murió entre RECORDED y el cierre')
    })
    const r = await devolver(p.orderId)
    expect(r.status).toBe('RECORDED')
    expect((await enLinea(p.orderId)).refundedAt).toBeNull()

    // El banco la regresa: la revisión tardía la revierte (commit) y el proceso muere antes de avisar al negocio.
    stripeDice(r.cardRefundId, 'FAILED')
    ;(sendVenueNotification as jest.Mock).mockImplementationOnce(() => {
      throw new Error('el proceso murió antes del aviso de la reversa')
    })
    await expect(advanceCardRefund(r.cardRefundId, enUnRato(61 * MIN))).rejects.toThrow('antes del aviso de la reversa')
    expect((await fila(r.cardRefundId)).status).toBe('REVERSED')

    // El barrido cierra el pedido igual.
    await expect(cerrarDevueltosPendientes({ venueId: venueId! }, new Date())).resolves.toBe(1)
    const oo = await enLinea(p.orderId)
    expect(oo.status).toBe('COMPLETED')
    expect(oo.refundedAt).not.toBeNull()
    expect(await cierres(p.onlineOrderId)).toBe(1)
    // La obligación sigue visible para el negocio: la reversa sin resolver, su anomalía y el seguimiento «revertida».
    const [devolucion] = await listCardRefunds(venueId!, p.orderId)
    expect(devolucion).toMatchObject({ id: r.cardRefundId, status: 'REVERSED', reversal: { resolvedAt: null } })
    expect(
      await prisma.moneyAnomaly.count({
        where: { category: 'ONLINE_ORDER_CARD_REFUND_REVERSED', expectedState: { path: ['cardRefundId'], equals: r.cardRefundId } },
      }),
    ).toBe(1)
    expect((await getTrackingByToken(p.trackingToken))?.refund).toEqual({ status: 'REVERSED', medio: 'TARJETA' })
  })

  it('cierre tardío: una fila RESOLVED que el calendario ya no visita (sello revertido, nextCheckAt fuera del barrido) cierra igual el pedido pendiente', async () => {
    const p = await cobrado()
    // Lo que deja una devolución anotada, revertida por el banco y pagada por otro medio, cuyo cierre se perdió: la reserva viva.
    await prisma.onlineOrder.update({ where: { id: p.onlineOrderId }, data: { refundRequestedAt: new Date() } })
    const resuelta = await prisma.onlineOrderCardRefund.create({
      data: {
        venueId: venueId!,
        chargeId: p.chargeId,
        key: llave(),
        amountCents: 25_000,
        reason: 'CANCELLED_ORDER',
        staffId: staffId!,
        requestHash: `resuelta-${RUN}`,
        status: 'RESOLVED',
        stampReversedAt: new Date(),
        nextCheckAt: NEVER_AGAIN,
      },
    })
    expect(resuelta.nextCheckAt).toEqual(NEVER_AGAIN)

    await expect(cerrarDevueltosPendientes({ venueId: venueId! }, new Date())).resolves.toBe(1)
    const oo = await enLinea(p.orderId)
    expect(oo.status).toBe('COMPLETED')
    expect(oo.refundedAt).not.toBeNull()
    expect(await cierres(p.onlineOrderId)).toBe(1)
  })

  // ── La cocina ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('con la devolución reservada o hecha no se arma comanda nueva, no se reclama papel y no se marca «Listo»; si la devolución falla, cocina retoma; sellada, se limpia kitchenPendingAt', async () => {
    // (1) Reservada: cobrado con la comanda de pantalla sin armar.
    const p = await cobrado()
    expect((await cuenta(p.orderId)).kitchenPendingAt).not.toBeNull()
    estadoNuevo = 'PENDING'
    const r = await devolver(p.orderId)
    await authorKitchenTickets({ venueId: venueId!, orderId: p.orderId, trigger: 'SWEEP' })
    expect(await comandasDe(p.orderId)).toBe(0)
    await expect(claimOnlineOrderPrint(venueId!, p.orderId, 'caja-1')).resolves.toEqual({ claimed: false })
    await expect(markOnlineOrderReady({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })).resolves.toMatchObject({
      outcome: 'STALE',
      status: 'ACCEPTED',
      refundRequestedAt: expect.any(String),
    })
    const listo = await porLaCaja('ready', p.orderId)
    expect(listo.status).toBe(409)
    expect(listo.body.error).toMatch(/no se marca listo/)
    expect((await enLinea(p.orderId)).status).toBe('ACCEPTED')

    // (2) La devolución falla: cocina retoma con UNA comanda y el papel se vuelve a pedir.
    stripeDice(r.cardRefundId, 'FAILED')
    await expect(advanceCardRefund(r.cardRefundId)).resolves.toBe('FAILED')
    expect((await cuenta(p.orderId)).kitchenPendingAt).not.toBeNull()
    await authorKitchenTickets({ venueId: venueId!, orderId: p.orderId, trigger: 'SWEEP' })
    await authorKitchenTickets({ venueId: venueId!, orderId: p.orderId, trigger: 'SWEEP' })
    expect(await comandasDe(p.orderId)).toBe(1)
    await expect(claimOnlineOrderPrint(venueId!, p.orderId, 'caja-1')).resolves.toEqual({ claimed: true })

    // (3) Hecha (sellada): se limpia la marca y no se arma, no se reclama papel ni se marca «Listo».
    const q = await cobrado()
    estadoNuevo = 'SUCCEEDED'
    await expect(devolver(q.orderId)).resolves.toMatchObject({ status: 'RECORDED' })
    expect((await cuenta(q.orderId)).kitchenPendingAt).toBeNull()
    await authorKitchenTickets({ venueId: venueId!, orderId: q.orderId, trigger: 'SWEEP' })
    expect(await comandasDe(q.orderId)).toBe(0)
    await expect(claimOnlineOrderPrint(venueId!, q.orderId, 'caja-1')).resolves.toEqual({ claimed: false })
    await expect(markOnlineOrderReady({ venueId: venueId!, orderId: q.orderId, staffId: staffId! })).resolves.toMatchObject({
      outcome: 'STALE',
      status: 'COMPLETED',
    })
  })

  it.each(['FAILED', 'CANCELED'] as const)(
    'r6 #3: cocina no pierde su trabajo — el barrido de cocina de los 15 min pasa con la reserva viva; la devolución termina %s; tras reiniciar, la siguiente pasada arma UNA sola comanda',
    async desenlace => {
      const p = await cobrado()
      estadoNuevo = 'PENDING'
      const r = await devolver(p.orderId)
      // El barrido de cocina pasa con la reserva viva, ya en el último intento de su marca (más de 15 min).
      await cocina(enUnRato(16 * MIN)).runNow()
      expect(await comandasDe(p.orderId)).toBe(0)
      expect((await cuenta(p.orderId)).kitchenPendingAt).toBeNull()

      // La devolución falla (lo que Stripe contesta en la siguiente pasada del reconciliador)…
      stripeDice(r.cardRefundId, desenlace)
      await expect(advanceCardRefund(r.cardRefundId)).resolves.toBe(desenlace)
      expect((await enLinea(p.orderId)).refundRequestedAt).toBeNull()

      // …y tras reiniciar, la siguiente pasada del barrido de cocina arma UNA sola comanda; otra pasada no arma otra.
      await cocina(enUnRato(MIN)).runNow()
      expect(await comandasDe(p.orderId)).toBe(1)
      await cocina(enUnRato(2 * MIN)).runNow()
      expect(await comandasDe(p.orderId)).toBe(1)
    },
  )

  // ── Entregado, comisiones y cancelar ────────────────────────────────────────────────────────────────────────────────────────

  it('devolver un pedido ya entregado: queda COMPLETED con refundedAt, la venta como reembolsada', async () => {
    const p = await cobrado()
    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })).resolves.toEqual({
      outcome: 'OK',
      status: 'COMPLETED',
    })
    const entregado = await enLinea(p.orderId)
    await expect(devolver(p.orderId)).resolves.toMatchObject({ status: 'RECORDED' })
    const oo = await enLinea(p.orderId)
    expect(oo).toMatchObject({ status: 'COMPLETED', completedAt: entregado.completedAt, refundRequestedAt: null })
    expect(oo.refundedAt).not.toBeNull()
    expect(await cuenta(p.orderId)).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
    const ledger = await refundsOf(p.orderId)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].amount.toFixed(2)).toBe('-250.00')
    expect(await cierres(p.onlineOrderId)).toBe(1)
  })

  it('«Entregado» sobre un pedido YA COMPLETED con refundedAt devuelve su estado, no éxito', async () => {
    const p = await cobrado()
    await expect(devolver(p.orderId)).resolves.toMatchObject({ status: 'RECORDED' })
    const { refundedAt } = await enLinea(p.orderId)
    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })).resolves.toEqual({
      outcome: 'STALE',
      status: 'COMPLETED',
      refundRequestedAt: expect.any(String),
      refundedAt: refundedAt!.toISOString(),
    })
    const r = await porLaCaja('delivered', p.orderId)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'ORDER_STATE_CHANGED', status: 'COMPLETED', refundedAt: refundedAt!.toISOString() })
    expect(r.body.error).toMatch(/ya se devolvió/)
  })

  it('los efectos de comisión de la devolución se encolan igual que hoy', async () => {
    const p = await cobrado()
    const r = await devolver(p.orderId)
    const original = await prisma.payment.findFirstOrThrow({ where: { orderId: p.orderId, type: 'REGULAR' } })
    // Una sola vez, por el envoltorio de siempre (`issueRefund`), con el renglón REFUND y su cobro original.
    expect(enqueueRefundPaymentEffectsInTx).toHaveBeenCalledTimes(1)
    expect((enqueueRefundPaymentEffectsInTx as jest.Mock).mock.calls[0].slice(1)).toEqual([r.refundId, original.id])
  })

  it('una venta PAID normal sigue sin poder cancelarse', async () => {
    const p = await cobrado()
    await expect(cancelOnlineOrderByStaff({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })).resolves.toEqual({
      outcome: 'HAS_PAYMENTS',
    })
    // Con la devolución en curso tampoco: devolver no abre la puerta de cancelar.
    estadoNuevo = 'PENDING'
    await devolver(p.orderId)
    await expect(cancelOnlineOrderByStaff({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })).resolves.toEqual({
      outcome: 'HAS_PAYMENTS',
    })
    expect(await cuenta(p.orderId)).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' })
    expect((await enLinea(p.orderId)).status).toBe('ACCEPTED')
  })

  // ── Ruling 9 y la vista previa del MCP ──────────────────────────────────────────────────────────────────────────────────────

  it('Ruling 9: con un reclamo de papel en vuelo la devolución no se reserva (409 PRINT_IN_FLIGHT); con el papel confirmado, sí', async () => {
    const p = await cobrado()
    await expect(claimOnlineOrderPrint(venueId!, p.orderId, 'caja-1')).resolves.toEqual({ claimed: true })
    await expect(devolver(p.orderId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRINT_IN_FLIGHT',
      message: 'Se está imprimiendo la comanda; intenta en un momento',
    })
    expect(await filasDe(p.chargeId)).toBe(0)
    expect((await enLinea(p.orderId)).refundRequestedAt).toBeNull()
    expect(refundSpy).not.toHaveBeenCalled()
    await expect(confirmOnlineOrderPrinted(venueId!, p.orderId, 'caja-1')).resolves.toEqual({ ok: true })
    await expect(devolver(p.orderId)).resolves.toMatchObject({ status: 'RECORDED' })
  })

  it('Ruling 9 (corte inverso, sin candado): un reclamo de papel que gana entre la lectura y la reserva hace perder la reserva (409 PRINT_IN_FLIGHT); nunca papel en vuelo y «Devolviendo…» a la vez', async () => {
    const p = await cobrado()
    // El reclamo de papel no toma el candado de la orden: llega (en su propia conexión) justo antes del CAS de la reserva.
    const original = prisma.$transaction.bind(prisma) as any
    let reclamo: unknown = 'no llegó'
    const envolver = (tx: any) =>
      new Proxy(tx, {
        get: (cliente, k) => {
          const valor = Reflect.get(cliente, k)
          if (k !== 'onlineOrder') return typeof valor === 'function' ? valor.bind(cliente) : valor
          return new Proxy(valor, {
            get: (delegado, m) => {
              const f = Reflect.get(delegado, m)
              if (m !== 'updateMany') return typeof f === 'function' ? f.bind(delegado) : f
              return async (args: any) => {
                if (reclamo === 'no llegó' && args?.data?.refundRequestedAt instanceof Date) {
                  reclamo = await claimOnlineOrderPrint(venueId!, p.orderId, 'caja-2')
                }
                return f.call(delegado, args)
              }
            },
          })
        },
      })
    const espia = jest
      .spyOn(prisma, '$transaction')
      .mockImplementation(((cuerpo: any, opciones?: any) =>
        typeof cuerpo === 'function' ? original((tx: any) => cuerpo(envolver(tx)), opciones) : original(cuerpo, opciones)) as any)
    try {
      await expect(devolver(p.orderId)).rejects.toMatchObject({ statusCode: 409, code: 'PRINT_IN_FLIGHT' })
    } finally {
      espia.mockRestore()
    }
    expect(reclamo).toEqual({ claimed: true })
    const oo = await enLinea(p.orderId)
    expect(oo.refundRequestedAt).toBeNull()
    expect(oo.printClaimedAt).not.toBeNull()
    expect(await filasDe(p.chargeId)).toBe(0)
    expect(refundSpy).not.toHaveBeenCalled()
  })

  it('MCP: el efecto esperado se revalida bajo el candado — si el pedido se entregó entre la vista previa y la confirmación, 409 y nada escrito', async () => {
    const p = await cobrado()
    await markOnlineOrderDelivered({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })
    await expect(devolver(p.orderId, { efectoEsperado: { cierraComoDevuelto: true } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFUND_EFFECT_CHANGED',
    })
    expect(await filasDe(p.chargeId)).toBe(0)
    expect(refundSpy).not.toHaveBeenCalled()
    await expect(devolver(p.orderId, { efectoEsperado: { cierraComoDevuelto: false } })).resolves.toMatchObject({ status: 'RECORDED' })
  })

  // ── La matriz de caídas (r6) ────────────────────────────────────────────────────────────────────────────────────────────────

  it('matriz: abortar entre la reserva y la fila → rollback: ni reserva ni fila; el reintento con la misma llave devuelve bien', async () => {
    const p = await cobrado()
    const k = llave()
    const c = cortarDentroDeLaTransaccion(
      'onlineOrderCardRefund',
      'create',
      a => a?.data?.key === k,
      'el proceso murió entre la reserva y la fila',
    )
    try {
      await expect(devolver(p.orderId, { key: k })).rejects.toThrow('entre la reserva y la fila')
    } finally {
      c.restaurar()
    }
    expect(c.cortado()).toBe(true)
    expect((await enLinea(p.orderId)).refundRequestedAt).toBeNull()
    expect(await filasDe(p.chargeId)).toBe(0)
    expect(refundSpy).not.toHaveBeenCalled()
    await expect(devolver(p.orderId, { key: k })).resolves.toMatchObject({ status: 'RECORDED', replay: false })
  })

  it('matriz: cortar tras SENDING y tras aceptar Stripe sin guardar su id → la siguiente pasada la encuentra por su marca y cierra; si Stripe no la tiene, se re-envía con la misma llave', async () => {
    // (a) Stripe la aceptó y se perdió la respuesta.
    const p = await cobrado()
    refundSpy.mockImplementationOnce(async (m: unknown, prm: any) => {
      await stripeDevuelve(m, prm)
      throw Object.assign(new Error('se perdió la respuesta'), { type: 'StripeConnectionError' })
    })
    const r = await devolver(p.orderId)
    expect(r).toMatchObject({ status: 'UNKNOWN', cardRefundStatus: 'SENDING' })
    expect((await fila(r.cardRefundId)).stripeRefundId).toBeNull()
    expect((await enLinea(p.orderId)).refundRequestedAt).not.toBeNull()
    await expect(advanceCardRefundForSweep(r.cardRefundId, enUnRato(MIN))).resolves.toMatchObject({ status: 'RECORDED' })
    expect(refundSpy).toHaveBeenCalledTimes(1)
    expect(await refundsOf(p.orderId)).toHaveLength(1)
    expect((await enLinea(p.orderId)).status).toBe('COMPLETED')

    // (b) Cortado tras SENDING, sin que Stripe la tenga: a los 5 min se re-envía con la MISMA llave y cierra.
    const q = await cobrado()
    refundSpy.mockClear()
    refundSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Stripe no contestó'), { type: 'StripeConnectionError' })
    })
    const s = await devolver(q.orderId)
    expect(s).toMatchObject({ status: 'UNKNOWN', cardRefundStatus: 'SENDING' })
    await expect(advanceCardRefundForSweep(s.cardRefundId, enUnRato(MIN))).resolves.toMatchObject({ status: 'SENDING' })
    await expect(advanceCardRefundForSweep(s.cardRefundId, enUnRato(6 * MIN))).resolves.toMatchObject({ status: 'RECORDED' })
    const llaves = refundSpy.mock.calls.map(c => c[1].idempotencyKey)
    expect(llaves).toHaveLength(2)
    expect(new Set(llaves).size).toBe(1)
    expect(await refundsOf(q.orderId)).toHaveLength(1)
    expect((await enLinea(q.orderId)).status).toBe('COMPLETED')
  })

  it('matriz: caída tras el renglón REFUND y antes de RECORDED → un solo renglón, mismos efectos, cierre con refundedAt y sale de «Devolviendo…»', async () => {
    const p = await cobrado()
    const escribir = prisma.onlineOrderCardRefund.updateMany.bind(prisma.onlineOrderCardRefund)
    let murio = false
    const espia = jest.spyOn(prisma.onlineOrderCardRefund, 'updateMany').mockImplementation((async (args: any) => {
      if (!murio && args?.data?.status === 'RECORDED') {
        murio = true
        throw new Error('el proceso murió tras el renglón REFUND')
      }
      return escribir(args)
    }) as never)
    let r: Awaited<ReturnType<typeof devolver>>
    try {
      r = await devolver(p.orderId)
    } finally {
      espia.mockRestore()
    }
    expect(murio).toBe(true)
    expect(r).toMatchObject({ status: 'UNKNOWN', cardRefundStatus: 'SUCCEEDED' })
    expect(await refundsOf(p.orderId)).toHaveLength(1)
    expect(enqueueRefundPaymentEffectsInTx).toHaveBeenCalledTimes(1)
    expect((await enLinea(p.orderId)).refundRequestedAt).not.toBeNull()

    await expect(advanceCardRefundForSweep(r.cardRefundId, new Date())).resolves.toMatchObject({ status: 'RECORDED' })
    expect(await refundsOf(p.orderId)).toHaveLength(1)
    expect(enqueueRefundPaymentEffectsInTx).toHaveBeenCalledTimes(1)
    const oo = await enLinea(p.orderId)
    expect(oo.status).toBe('COMPLETED')
    expect(oo.refundedAt).not.toBeNull()
    expect(await cierres(p.onlineOrderId)).toBe(1)
  })
})
