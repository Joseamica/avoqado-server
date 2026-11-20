// tests/integration/online-ordering/tarjetaEnNadieEntregaYCierre.integration.test.ts
/**
 * Integration (REAL DB) — D661 tarea 4: entrega, cierre del día, «No lo recogió» y el seguimiento público. Lo que los simulacros no
 * prueban: el SQL real del corte de las 04:00 en la zona del negocio, el CAS que repite sus guardas cuando una entrega o una reserva de
 * devolución gana después de leer los candidatos, la bitácora en la MISMA transacción que el CAS (una sola fila aunque el proceso muera
 * entre los dos), la regla de la comanda, el 409 por las rutas reales de la caja y las filas reales de devolución del seguimiento.
 * Stripe es un doble siempre. Todo se acota a la sucursal de esta prueba (el corte corre con `venueId`).
 */
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { cerrarFoliosDelDiaTerminado, listFolios } from '@/services/online-ordering/folios.service'
import { getInboxOrder } from '@/services/online-ordering/inbox.service'
import { claimOnlineOrderPrint } from '@/services/online-ordering/printClaim.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { getTrackingByToken } from '@/services/online-ordering/order.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { acceptOnlineOrder, cancelOnlineOrderByStaff, markOnlineOrderDelivered } from '@/services/online-ordering/transitions.service'
import mobileRouter from '@/routes/mobile/onlineOrders.mobile.routes'
import tpvRouter from '@/routes/tpv/onlineOrders.tpv.routes'

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
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
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
/** El último corte del día del negocio (04:00 en su zona) que ya pasó; con un texto, nunca con la zona de la máquina. */
const ultimoCorte = () => fromZonedTime(`${formatInTimeZone(new Date(Date.now() - 4 * 60 * MIN), TZ, 'yyyy-MM-dd')}T04:00:00.000`, TZ)

describe('D661 · tarea 4: entrega, cierre del día, «No lo recogió» y el seguimiento (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let productId: string
  const clientas: string[] = []
  let turno = 0
  let seq = 0
  const llave = () => `entrega-${RUN}-${++seq}-`.padEnd(40, 'x')

  const sesiones = new Map<string, { id: string; url: string; expiresAt: Date }>()
  let checkoutSpy: jest.SpyInstance
  let authSpy: jest.SpyInstance
  let captureSpy: jest.SpyInstance
  let voidSpy: jest.SpyInstance
  let piSeq = 0
  const autorizada = (authorizedAt: Date, paymentIntentId = `pi_entrega_${RUN}_${++piSeq}`) => ({
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

  const cargo = (id: string) => prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id } })
  const enLinea = (orderId: string) => prisma.onlineOrder.findFirstOrThrow({ where: { orderId } })
  const cuenta = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const bitacorasNoRecogido = (onlineOrderId: string) =>
    prisma.activityLog.count({ where: { venueId: venueId!, entityId: onlineOrderId, action: 'ONLINE_ORDER_NOT_PICKED_UP' } })
  /** Un apartado de «Nadie» de una clienta con sesión: borrador + autorización de Stripe hace un minuto. */
  const apartado = async () => {
    const d = await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-entrega-${RUN}`,
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
    const c = await cargo(c0.id)
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c.onlineOrderId! } })
    return { chargeId: c.id, orderId: oo.orderId, onlineOrderId: oo.id, trackingToken: d.trackingToken }
  }
  /** Un apartado que una caja ya abrió: cobrado, «Por entregar» y con la comanda pendiente. */
  const cobrado = async () => {
    const a = await apartado()
    await expect(
      acceptOnlineOrder({ venueId: venueId!, orderId: a.orderId, staffId: null, abrirPagadoEnLinea: true }),
    ).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    return a
  }
  /** Lo cobrado quedó del día anterior (aceptado un minuto antes del último corte), como si la caja lo hubiera abierto ayer. */
  const deAyer = (onlineOrderId: string) =>
    prisma.onlineOrder.update({ where: { id: onlineOrderId }, data: { acceptedAt: new Date(ultimoCorte().getTime() - MIN) } })
  /** El corte del día, acotado a esta sucursal y con el reloj real. */
  const corte = (readCandidates?: Parameters<typeof cerrarFoliosDelDiaTerminado>[2]) =>
    cerrarFoliosDelDiaTerminado({ venueId: venueId! }, () => new Date(), readCandidates)
  /** Un folio de «Nadie» pagado en la caja (sin tarjeta), ya «Por entregar» desde ayer: lo que deja el cobro de la TPV. */
  const folioDeCajaPagado = async () => {
    const k = ++seq
    const order = await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ENT-${RUN}-${k}`,
        type: 'PICKUP',
        source: 'WEB',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subtotal: 250,
        discountAmount: 0,
        taxAmount: 0,
        tipAmount: 0,
        total: 250,
        paidAmount: 250,
        remainingBalance: 0,
        items: { create: [{ productId, productName: 'Orden grande', quantity: 1, unitPrice: 250, total: 250, taxAmount: 0 }] },
      },
    })
    const oo = await prisma.onlineOrder.create({
      data: {
        orderId: order.id,
        venueId: venueId!,
        status: 'ACCEPTED',
        paymentMode: 'PAY_AT_PICKUP',
        requiresAcceptance: false,
        channel: 'QR',
        trackingToken: `ent-${RUN}-${k}`.padEnd(40, 't'),
        acceptDeadlineAt: new Date(Date.now() - 60 * MIN),
        acceptedAt: new Date(ultimoCorte().getTime() - MIN),
      },
    })
    return { orderId: order.id, onlineOrderId: oo.id }
  }
  /** Las rutas REALES de la caja (POS y TPV), con la sesión de la cajera de la sucursal. */
  const cajas = express()
  cajas.use(express.json())
  cajas.use('/m/venues/:venueId/online-orders', mobileRouter)
  cajas.use('/t/venues/:venueId/online-orders', tpvRouter)
  cajas.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ code: err.code, error: err.message }))
  const entregarPorLaCaja = (namespace: 'm' | 't', orderId: string) =>
    request(cajas)
      .post(`/${namespace}/venues/${venueId}/online-orders/${orderId}/delivered`)
      .set('x-test-staff', staffId!)
      .set('x-test-venue', venueId!)
      .send({})
  const comandas = async () => (await listFolios({ venueId: venueId! })).comandasPorImprimir.map(c => c.orderId)

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Entrega Org', slug: `itest-entrega-org-${RUN}`, email: `itest-entrega-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Entrega Venue',
        slug: `itest-entrega-${RUN}`,
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
        data: { email: `itest-entrega-caja-${RUN}@test.com`, firstName: 'Caja', lastName: 'ITEST', active: true },
      })
    ).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-entrega-${RUN}` } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-entrega-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `ENTREGA-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    for (let i = 0; i < 25; i++) {
      clientas.push(
        (await prisma.customer.create({ data: { venueId, email: `entrega${i}-${RUN}@test.com`, firstName: `Clienta ${i}` } })).id,
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
        businessName: 'ITEST Entrega',
        contactEmail: `itest-entrega-merchant-${RUN}@test.com`,
        publicKey: `pk_test_itest_entrega_${RUN}`,
        secretKeyHash: `itest-entrega-hash-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: 'acct_itest_entrega' },
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
        const id = `cs_itest_entrega_${RUN}_${sesiones.size + 1}`
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
    ;(logAction as jest.Mock).mockClear()
    // Lo de la prueba anterior de ESTA sucursal queda resuelto (con su comanda impresa): sólo cuenta lo de cada prueba.
    await prisma.onlineOrderCharge.updateMany({ where: { venueId: venueId!, status: 'PENDING_AUTH' }, data: { status: 'ABANDONED' } })
    await prisma.onlineOrder.updateMany({ where: { venueId: venueId!, status: 'PENDING_ACCEPTANCE' }, data: { status: 'EXPIRED' } })
    await prisma.onlineOrder.updateMany({
      where: { venueId: venueId!, OR: [{ status: { in: ['ACCEPTED', 'READY'] } }, { status: 'COMPLETED', printedAt: null }] },
      data: { status: 'COMPLETED', printedAt: new Date() },
    })
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
    await prisma.paymentEffect.deleteMany({ where: v })
    await prisma.inventoryPosting.deleteMany({ where: v })
    await prisma.venueTransaction.deleteMany({ where: v })
    await prisma.payment.deleteMany({ where: v })
    await prisma.onlineOrderCardRefundReversal.deleteMany({ where: v })
    await prisma.onlineOrderCardRefund.deleteMany({ where: v })
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

  // ── El cierre del día (04:00 en la zona del negocio) ──────────────────────────────────────────────────────────────────────────

  it('cierre: un «Nadie» cobrado en línea sin entregar, con acceptedAt antes del corte, pasa a COMPLETED con notPickedUpAt y bitácora ONLINE_ORDER_NOT_PICKED_UP', async () => {
    const a = await cobrado()
    await deAyer(a.onlineOrderId)
    await expect(corte()).resolves.toBe(1)

    const oo = await enLinea(a.orderId)
    expect(oo.status).toBe('COMPLETED')
    expect(oo.notPickedUpAt).not.toBeNull()
    expect(oo.notPickedUpAt).toEqual(oo.completedAt)
    expect(oo.refundRequestedAt).toBeNull()
    // La cuenta y el dinero no se tocan: la venta sigue cobrada.
    expect(await cuenta(a.orderId)).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' })
    expect((await cargo(a.chargeId)).status).toBe('CAPTURED')
    expect(await bitacorasNoRecogido(a.onlineOrderId)).toBe(1)
    // Nunca se dice «Entregado» de lo que nadie recogió.
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_COLLECTED', entityId: a.onlineOrderId }))

    // Otra pasada no lo vuelve a tocar ni repite la bitácora.
    await expect(corte()).resolves.toBe(0)
    expect(await bitacorasNoRecogido(a.onlineOrderId)).toBe(1)
  })

  it('cierre: cobrado después del corte (04:00 local) no se toca', async () => {
    const a = await cobrado()
    // La caja lo abrió (y se cobró) un minuto DESPUÉS del último corte: es del día de hoy, que no ha terminado.
    await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { acceptedAt: new Date(ultimoCorte().getTime() + MIN) } })
    const ayer = await cobrado()
    await deAyer(ayer.onlineOrderId)

    await expect(corte()).resolves.toBe(1) // sólo el de ayer
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'ACCEPTED', notPickedUpAt: null, completedAt: null })
    expect(await bitacorasNoRecogido(a.onlineOrderId)).toBe(0)
    expect((await enLinea(ayer.orderId)).status).toBe('COMPLETED')
  })

  it('cierre: con refundRequestedAt o refundedAt no se toca', async () => {
    const reservado = await cobrado()
    const devuelto = await cobrado()
    for (const [p, marca] of [
      [reservado, 'refundRequestedAt'],
      [devuelto, 'refundedAt'],
    ] as const) {
      await deAyer(p.onlineOrderId)
      await prisma.onlineOrder.update({ where: { id: p.onlineOrderId }, data: { [marca]: new Date() } })
    }
    await expect(corte()).resolves.toBe(0)
    for (const p of [reservado, devuelto]) {
      expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', notPickedUpAt: null })
      expect(await bitacorasNoRecogido(p.onlineOrderId)).toBe(0)
    }
  })

  it('cierre: un folio pagado en caja sigue como hoy', async () => {
    const f = await folioDeCajaPagado()
    await expect(corte()).resolves.toBe(1)
    const oo = await enLinea(f.orderId)
    expect(oo.status).toBe('COMPLETED')
    expect(oo.completedAt).not.toBeNull()
    expect(oo.notPickedUpAt).toBeNull() // un folio de caja nunca es «No lo recogió»
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONLINE_ORDER_COLLECTED',
        entityId: f.onlineOrderId,
        staffId: null,
        data: expect.objectContaining({ automatic: 'END_OF_DAY' }),
      }),
    )
    expect(await bitacorasNoRecogido(f.onlineOrderId)).toBe(0)
  })

  it('cierre (matriz r6): una entrega o una reserva de devolución que gana DESPUÉS de leer los candidatos hace perder el CAS; no se escribe la bitácora', async () => {
    const entregado = await cobrado()
    const devolviendo = await cobrado()
    for (const p of [entregado, devolviendo]) await deAyer(p.onlineOrderId)

    // Entre la lectura del corte y su escritura: una persona entrega uno y la devolución del otro se reserva (Task 5 la escribe así).
    const ganados = await corte(async leer => {
      const filas = await leer()
      // `readCandidates` es genérico: las filas del corte se leen con su forma (id del pedido en línea).
      const ids = (filas as unknown as Array<{ id: string }>).map(f => f.id)
      expect(ids.sort()).toEqual([entregado.onlineOrderId, devolviendo.onlineOrderId].sort())
      await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId: entregado.orderId, staffId: staffId! })).resolves.toEqual({
        outcome: 'OK',
        status: 'COMPLETED',
      })
      await prisma.onlineOrder.update({ where: { id: devolviendo.onlineOrderId }, data: { refundRequestedAt: new Date() } })
      return filas
    })
    expect(ganados).toBe(0)
    expect(await enLinea(entregado.orderId)).toMatchObject({ status: 'COMPLETED', notPickedUpAt: null }) // «Entregado», no «No lo recogió»
    expect(await enLinea(devolviendo.orderId)).toMatchObject({ status: 'ACCEPTED', notPickedUpAt: null })
    for (const p of [entregado, devolviendo]) expect(await bitacorasNoRecogido(p.onlineOrderId)).toBe(0)
  })

  it('cierre (matriz r6): si el proceso muere entre el CAS y la bitácora no queda ninguno; la siguiente pasada lo cierra con UNA sola fila ONLINE_ORDER_NOT_PICKED_UP', async () => {
    const a = await cobrado()
    await deAyer(a.onlineOrderId)

    // «Morir» = la escritura de la bitácora truena DENTRO de la transacción del CAS (el CAS ya corrió en ella).
    const original = prisma.$transaction.bind(prisma) as any
    let casCorrio = false
    const espia = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((cuerpo: any, opciones?: any) =>
      original(async (tx: any) => {
        const conMuerte = new Proxy(tx, {
          get: (cliente, k) => {
            if (k === 'activityLog') {
              return {
                create: async () => {
                  casCorrio = (await tx.onlineOrder.findFirst({ where: { id: a.onlineOrderId } }))?.status === 'COMPLETED'
                  throw new Error('el proceso murió entre el CAS y la bitácora')
                },
              }
            }
            const valor = Reflect.get(cliente, k)
            return typeof valor === 'function' ? valor.bind(cliente) : valor
          },
        })
        return cuerpo(conMuerte)
      }, opciones)) as any)
    try {
      await expect(corte()).resolves.toBe(0)
    } finally {
      espia.mockRestore()
    }
    expect(casCorrio).toBe(true) // el CAS sí escribió dentro de la transacción…
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'ACCEPTED', notPickedUpAt: null, completedAt: null }) // …y se revirtió
    expect(await bitacorasNoRecogido(a.onlineOrderId)).toBe(0)

    // La siguiente pasada (tras reiniciar) lo cierra con su única bitácora; otra más no la repite.
    await expect(corte()).resolves.toBe(1)
    expect((await enLinea(a.orderId)).notPickedUpAt).not.toBeNull()
    expect(await bitacorasNoRecogido(a.onlineOrderId)).toBe(1)
    await expect(corte()).resolves.toBe(0)
    expect(await bitacorasNoRecogido(a.onlineOrderId)).toBe(1)
  })

  // ── «Entregado» ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('entregar uno marcado «No lo recogió» → 409 con su estado', async () => {
    const a = await cobrado()
    await deAyer(a.onlineOrderId)
    await corte()
    const { notPickedUpAt, completedAt } = await enLinea(a.orderId)
    for (const namespace of ['m', 't'] as const) {
      const r = await entregarPorLaCaja(namespace, a.orderId)
      expect({ namespace, status: r.status }).toEqual({ namespace, status: 409 })
      expect(r.body).toMatchObject({
        success: false,
        code: 'ORDER_STATE_CHANGED',
        status: 'COMPLETED',
        notPickedUpAt: notPickedUpAt!.toISOString(),
      })
      expect(r.body.error).toContain('«No lo recogió»')
    }
    // Nada cambió: sigue «No lo recogió» con la hora del corte, sin otra bitácora.
    expect(await enLinea(a.orderId)).toMatchObject({ status: 'COMPLETED', notPickedUpAt, completedAt })
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_COLLECTED', entityId: a.onlineOrderId }))
  })

  it('entregar un CARD_ONLINE con refundRequestedAt o refundedAt → 409', async () => {
    for (const marca of ['refundRequestedAt', 'refundedAt'] as const) {
      const a = await cobrado()
      const hora = new Date()
      await prisma.onlineOrder.update({ where: { id: a.onlineOrderId }, data: { [marca]: hora } })
      const r = await entregarPorLaCaja('m', a.orderId)
      expect({ marca, status: r.status }).toEqual({ marca, status: 409 })
      expect(r.body).toMatchObject({ code: 'ORDER_STATE_CHANGED', status: 'ACCEPTED', [marca]: hora.toISOString() })
      expect((await enLinea(a.orderId)).status).toBe('ACCEPTED')
      expect((await cuenta(a.orderId)).status).toBe('CONFIRMED')
    }
  })

  // ── La comanda (traspaso de 3B) ──────────────────────────────────────────────────────────────────────────────────────────────

  it('D661 (Task 4): la comanda de un pedido que una PERSONA marcó «Entregado» sin papel ya no se pide; la del que cerró el corte, sí', async () => {
    const entregado = await cobrado()
    const noRecogido = await cobrado()
    expect(await comandas()).toEqual(expect.arrayContaining([entregado.orderId, noRecogido.orderId]))

    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId: entregado.orderId, staffId: staffId! })).resolves.toEqual({
      outcome: 'OK',
      status: 'COMPLETED',
    })
    await deAyer(noRecogido.onlineOrderId)
    await expect(corte()).resolves.toBe(1)

    // La MISMA regla en la lista, en `needsPrint` y en el reclamo.
    const lista = await comandas()
    expect(lista).not.toContain(entregado.orderId)
    expect(lista).toContain(noRecogido.orderId)
    expect((await getInboxOrder({ venueId: venueId!, orderId: entregado.orderId }))?.needsPrint).toBe(false)
    expect((await getInboxOrder({ venueId: venueId!, orderId: noRecogido.orderId }))?.needsPrint).toBe(true)
    await expect(claimOnlineOrderPrint(venueId!, entregado.orderId, 'caja-1')).resolves.toEqual({ claimed: false })
    await expect(claimOnlineOrderPrint(venueId!, noRecogido.orderId, 'caja-1')).resolves.toEqual({ claimed: true })
  })

  // ── «Cancelar folio» sobre un apartado (traspaso de 3A) ──────────────────────────────────────────────────────────────────────

  it('D661 (Task 4): «Cancelar folio» sobre un apartado lo libera, el seguimiento dice que no se cobró y nunca queda cobrado', async () => {
    const a = await apartado()
    await expect(cancelOnlineOrderByStaff({ venueId: venueId!, orderId: a.orderId, staffId: staffId! })).resolves.toEqual({
      outcome: 'OK',
      status: 'CANCELLED_BY_STAFF',
    })
    // En la MISMA transacción de la cancelación el cargo quedó soltándose; mientras tanto el seguimiento no dice «liberado».
    expect((await cargo(a.chargeId)).status).toBe('RELEASING')
    expect(await getTrackingByToken(a.trackingToken)).toMatchObject({ status: 'CANCELLED_BY_STAFF', cardStatus: 'RELEASING', paid: false })

    // La pasada de RELEASING del conciliador (aquí, su paso por este cargo): Stripe lo suelta.
    await expect(releaseCharge(a.chargeId)).resolves.toBe('RELEASED')
    expect((await cargo(a.chargeId)).status).toBe('RELEASED')
    expect(await getTrackingByToken(a.trackingToken)).toMatchObject({
      status: 'CANCELLED_BY_STAFF',
      cardStatus: 'RELEASED',
      paid: false,
      canCancel: false,
    })

    // Una caja que intenta abrirlo después no lo cobra.
    await acceptOnlineOrder({ venueId: venueId!, orderId: a.orderId, staffId: null, abrirPagadoEnLinea: true })
    expect(captureSpy).not.toHaveBeenCalled()
    expect(voidSpy).toHaveBeenCalledTimes(1)
    expect(await prisma.payment.count({ where: { orderId: a.orderId } })).toBe(0)
    expect(await cuenta(a.orderId)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PENDING' })
  })

  // ── El seguimiento público ───────────────────────────────────────────────────────────────────────────────────────────────────

  it('el seguimiento trae notPickedUpAt, canCancel y el estado real de la devolución (pendiente, hecha o revertida)', async () => {
    // Un apartado de «Nadie» no se cancela desde el celular.
    const a = await apartado()
    expect(await getTrackingByToken(a.trackingToken)).toMatchObject({ status: 'PENDING_ACCEPTANCE', canCancel: false })

    const p = await cobrado()
    await deAyer(p.onlineOrderId)
    await corte()
    const { notPickedUpAt } = await enLinea(p.orderId)
    const sinDevolucion = await getTrackingByToken(p.trackingToken)
    expect(sinDevolucion).toMatchObject({
      status: 'COMPLETED',
      notPickedUpAt: notPickedUpAt!.toISOString(),
      refundedAt: null,
      canCancel: false,
    })
    expect(sinDevolucion).not.toHaveProperty('refund')

    // Las filas reales de devolución: una fallida no cuenta; la del momento manda (pendiente → hecha → revertida → pagada en efectivo).
    let k = 0
    const fila = (status: 'FAILED' | 'PENDING') =>
      prisma.onlineOrderCardRefund.create({
        data: {
          venueId: venueId!,
          chargeId: p.chargeId,
          key: `dev-${RUN}-${++k}`,
          amountCents: 25_000,
          reason: 'REQUESTED_BY_CUSTOMER',
          staffId: staffId!,
          requestHash: `hash-${RUN}-${k}`,
          status,
        },
      })
    await fila('FAILED')
    expect(await getTrackingByToken(p.trackingToken)).not.toHaveProperty('refund')
    const viva = await fila('PENDING')
    expect((await getTrackingByToken(p.trackingToken))?.refund).toEqual({ status: 'PENDING', medio: 'TARJETA' })
    await prisma.onlineOrderCardRefund.update({ where: { id: viva.id }, data: { status: 'RECORDED' } })
    const devueltoEn = new Date()
    await prisma.onlineOrder.update({ where: { id: p.onlineOrderId }, data: { refundedAt: devueltoEn } })
    expect(await getTrackingByToken(p.trackingToken)).toMatchObject({
      refund: { status: 'DONE', medio: 'TARJETA' },
      refundedAt: devueltoEn.toISOString(),
    })
    await prisma.onlineOrderCardRefund.update({ where: { id: viva.id }, data: { status: 'REVERSED' } })
    await prisma.onlineOrderCardRefundReversal.create({
      data: {
        venueId: venueId!,
        cardRefundId: viva.id,
        stripeRefundId: `re_entrega_${RUN}`,
        amountCents: 25_000,
        feeCents: 0,
        detectedAt: new Date(),
      },
    })
    expect((await getTrackingByToken(p.trackingToken))?.refund).toEqual({ status: 'REVERSED', medio: 'TARJETA' })
    // El negocio la pagó en efectivo: RESOLVED dice el medio que registró (la fila sigue con toStoreCredit en false).
    await prisma.onlineOrderCardRefund.update({ where: { id: viva.id }, data: { status: 'RESOLVED' } })
    await prisma.onlineOrderCardRefundReversal.update({
      where: { cardRefundId: viva.id },
      data: { resolvedMethod: 'CASH', resolvedAt: new Date() },
    })
    expect((await getTrackingByToken(p.trackingToken))?.refund).toEqual({ status: 'DONE', medio: 'EFECTIVO' })
  })
})
