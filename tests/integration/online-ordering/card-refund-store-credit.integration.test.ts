// tests/integration/online-ordering/card-refund-store-credit.integration.test.ts
/**
 * Integration (REAL DB) — D661 tarea 6: devolver a SALDO A FAVOR un pedido «Nadie» pagado con tarjeta en línea. Lo que los dobles no
 * prueban: en UNA transacción de Postgres, la reserva, la fila `RESOLVED` a saldo, el renglón REFUND con su abono al sobre, sus
 * efectos y el cierre «Devuelto» — y que si cualquier escritura falla no queda NADA; el candado «primer-sobre» antes de la orden
 * contra la devolución a la tarjeta del mismo pedido; el teléfono verificado al pagar (no el de la ficha de hoy); la devolución hecha
 * por fuera en Stripe (Ruling 28) en los dos destinos; el recorrido de Stripe que nunca toma una fila de saldo; y el cierre
 * compartido que no cierra sin la devolución anotada. Stripe es un doble siempre. Un «corte» hace tronar UNA escritura de la
 * transacción (por predicado, dentro del paso) y la siguiente llamada es nueva. Todo se acota a la sucursal de esta prueba.
 *
 * La libreta del saldo a favor no se puede borrar (trigger): sus sobres, su negocio y lo que los nombra se quedan en la base
 * desechable de la corrida (como en tests/integration/storeCredit). Ningún conteo es global: todo filtra por esta sucursal.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { listCardRefunds, refundCardOnlineOrder, type CardRefundDestino } from '@/services/online-ordering/card/refund.service'
import { sweepCardRefunds } from '@/services/online-ordering/card/refund-reconciler.service'
import { cerrarComoDevueltoEnTx } from '@/services/online-ordering/card/devuelto'
import { listFolios, syncPaidClosedFolios } from '@/services/online-ordering/folios.service'
import { NO_LO_RECOGIO_PAPEL_MS, claimOnlineOrderPrint, confirmOnlineOrderPrinted } from '@/services/online-ordering/printClaim.service'
import { listInbox } from '@/services/online-ordering/inbox.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { getTrackingByToken } from '@/services/online-ordering/order.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { acceptOnlineOrder, markOnlineOrderDelivered } from '@/services/online-ordering/transitions.service'
import { TENDER_SEMANTICS_SELECT, paymentCountsAsDrawerCash } from '@/services/shared/tenderSemantics'

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

jest.setTimeout(120_000)

const RUN = Date.now()
const MIN = 60_000
const PUEDE_CREAR = { assertCanCreate: async () => {} }
/** Un teléfono mexicano único por corrida (E.164), como lo deja la sesión que lo verificó. */
let tel = 0
const telefono = () => `+5255${String((RUN + ++tel * 7919) % 100_000_000).padStart(8, '0')}`

describe('D661 · tarea 6: devolver a saldo a favor un pedido «Nadie» (integration, real DB)', () => {
  let venueId: string | undefined
  let staffId: string | undefined
  let productId: string
  let seq = 0
  const llave = () => `saldo-${RUN}-${++seq}-`.padEnd(40, 'x')

  // ── Stripe, siempre un doble ──────────────────────────────────────────────────────────────────────────────────────────────────
  const sesiones = new Map<string, { id: string; url: string; expiresAt: Date }>()
  let checkoutSpy: jest.SpyInstance
  let authSpy: jest.SpyInstance
  let captureSpy: jest.SpyInstance
  let refundSpy: jest.SpyInstance
  let getRefundSpy: jest.SpyInstance
  let listRefundsSpy: jest.SpyInstance
  let feeSpy: jest.SpyInstance
  let chargeRefundsSpy: jest.SpyInstance
  let piSeq = 0
  type EnStripe = { refundId: string; amount: number; status: 'PENDING' | 'SUCCEEDED'; metadata: Record<string, string>; pi: string }
  /** Las devoluciones que Stripe tiene: las de Avoqado (por su llave) y las hechas por fuera (`porFuera`). */
  const enStripe = new Map<string, EnStripe>()
  const porFuera = (pi: string, amount: number, status: EnStripe['status']) =>
    enStripe.set(`fuera-${pi}-${enStripe.size}`, { refundId: `re_fuera_${RUN}_${enStripe.size}`, amount, status, metadata: {}, pi })
  const lecturaDelCargo = async (_m: unknown, pi: string) => {
    const delCargo = [...enStripe.values()].filter(d => d.pi === pi)
    return {
      amountRefundedCents: delCargo.reduce((t, d) => t + d.amount, 0),
      refunds: delCargo.map(d => ({
        refundId: d.refundId,
        status: d.status,
        amountCents: d.amount,
        failureReason: null,
        metadata: d.metadata,
      })),
    }
  }
  const autorizada = (paymentIntentId = `pi_saldo_${RUN}_${++piSeq}`) => ({
    sessionStatus: 'complete',
    paymentIntentId,
    piStatus: 'requires_capture',
    amountCapturableCents: 25_000,
    amountReceivedCents: 0,
    captureBefore: new Date(Date.now() + 7 * 24 * 60 * MIN),
    card: { brand: 'visa', last4: '4242', funding: 'credit' },
    paymentMethodType: 'card',
    authorizedAt: new Date(Date.now() - MIN),
  })

  // ── Lecturas (todas de esta sucursal) ─────────────────────────────────────────────────────────────────────────────────────────
  const v = () => ({ venueId: venueId! })
  const enLinea = (orderId: string) => prisma.onlineOrder.findFirstOrThrow({ where: { ...v(), orderId } })
  const filasDe = (chargeId: string) =>
    prisma.onlineOrderCardRefund.findMany({ where: { ...v(), chargeId }, orderBy: { createdAt: 'asc' }, take: 10 })
  const renglonesDe = (orderId: string) =>
    prisma.payment.findMany({ where: { ...v(), orderId, type: 'REFUND' }, include: { tenderType: true }, take: 10 })
  const sobresDe = (customerId: string) => prisma.giftCard.findMany({ where: { ...v(), customerId }, take: 10 })
  const movimientosDe = (orderId: string) => prisma.giftCardActivity.findMany({ where: { ...v(), orderId }, take: 10 })
  const efectosDe = (orderId: string) => prisma.paymentEffect.count({ where: { ...v(), orderId, payment: { type: 'REFUND' } } })
  const cierres = (onlineOrderId: string) =>
    prisma.activityLog.count({ where: { ...v(), entityId: onlineOrderId, action: 'ONLINE_ORDER_CLOSED_AS_REFUNDED' } })
  const cobroDe = (orderId: string) => prisma.payment.findFirstOrThrow({ where: { ...v(), orderId, type: 'REGULAR' } })

  // ── Clientas y pedidos ────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Una clienta con cuenta; `ficha` es el teléfono de su ficha HOY (puede no ser el que verificó al pagar). */
  const clienta = async (ficha: string | null = null) =>
    (
      await prisma.customer.create({
        data: { ...v(), email: `saldo-${RUN}-${++seq}@test.com`, firstName: 'Ana', lastName: `Nadie ${seq}`, phone: ficha },
      })
    ).id
  /** Un pedido «Nadie» de esa clienta, pagado con tarjeta (`verificado`: el teléfono que su sesión probó) y abierto por una caja. */
  const cobrado = async (customerId: string, verificado: string | null) => {
    // Su sesión probó ese número: es el de su ficha (si la ficha todavía no traía uno), como al entrar por WhatsApp.
    if (verificado) await prisma.customer.updateMany({ where: { id: customerId, phone: null }, data: { phone: verificado } })
    const d = await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-saldo-${RUN}`,
        idempotencyKey: llave(),
        items: [{ productId, quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'Ana Nadie', email: 'ana@test.com' },
        customerId,
        verifiedPhone: verificado,
      },
      PUEDE_CREAR,
    )
    const c0 = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { trackingToken: d.trackingToken } })
    authSpy.mockResolvedValueOnce(autorizada())
    await expect(confirmCardAuthorization(c0.id)).resolves.toBe('CREATED')
    const c = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: c0.id } })
    const oo = await prisma.onlineOrder.findUniqueOrThrow({ where: { id: c.onlineOrderId! } })
    await expect(
      acceptOnlineOrder({ venueId: venueId!, orderId: oo.orderId, staffId: null, abrirPagadoEnLinea: true }),
    ).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    return { chargeId: c.id, pi: c.paymentIntentId!, orderId: oo.orderId, onlineOrderId: oo.id, trackingToken: d.trackingToken }
  }
  /** «Cancelar y devolver» del panel, 100 %, al destino que se pida, con la vista del operador al día (o la que se diga). */
  const devolver = async (orderId: string, destino: CardRefundDestino, o: Partial<{ key: string; expected: string | null }> = {}) =>
    refundCardOnlineOrder({
      venueId: venueId!,
      orderId,
      amount: new Prisma.Decimal('250.00'),
      reason: 'CANCELLED_ORDER',
      staffId: staffId!,
      idempotencyKey: o.key ?? llave(),
      note: null,
      expectedLatestRefundId: o.expected === undefined ? ((await listCardRefunds(venueId!, orderId))[0]?.id ?? null) : o.expected,
      destino,
    })

  /** «No quedó nada»: ni fila, ni renglón, ni sobre nuevo, ni abono, ni efectos, ni reserva, ni cierre; el cobro sin acumulado. */
  const nadaEscrito = async (p: Awaited<ReturnType<typeof cobrado>>, customerId: string, sobresAntes = 0) => {
    expect(await filasDe(p.chargeId)).toHaveLength(0)
    expect(await renglonesDe(p.orderId)).toHaveLength(0)
    expect(await sobresDe(customerId)).toHaveLength(sobresAntes)
    expect(await movimientosDe(p.orderId)).toHaveLength(0)
    expect(await efectosDe(p.orderId)).toBe(0)
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', refundRequestedAt: null, refundedAt: null })
    expect(await cierres(p.onlineOrderId)).toBe(0)
    expect((await cobroDe(p.orderId)).processorData ?? {}).not.toHaveProperty('refundedAmountCents')
  }

  /**
   * Corta DENTRO de un paso de la transacción: envuelve toda transacción con un cliente que truena en la PRIMERA llamada a
   * `modelo.metodo` que cumpla `cortar` (sin tocar las demás). Devuelve con qué restaurar.
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
      data: { name: 'ITEST Saldo Org', slug: `itest-saldo-org-${RUN}`, email: `itest-saldo-${RUN}@test.com`, phone: '5550000000' },
    })
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Saldo Venue',
        slug: `itest-saldo-${RUN}`,
        organizationId: org.id,
        timezone: 'America/Mexico_City',
        address: 'Av. Coyoacán 123',
        city: 'CDMX',
        state: 'CDMX',
        zipCode: '04000',
        phone: '5512345678',
      },
    })
    venueId = venue.id
    staffId = (
      await prisma.staff.create({ data: { email: `itest-saldo-caja-${RUN}@test.com`, firstName: 'Caja', lastName: 'ITEST', active: true } })
    ).id
    await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-saldo-${RUN}` } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-saldo-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `SALDO-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: 'ITEST Saldo',
        contactEmail: `itest-saldo-merchant-${RUN}@test.com`,
        publicKey: `pk_test_itest_saldo_${RUN}`,
        secretKeyHash: `itest-saldo-hash-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: 'acct_itest_saldo' },
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
        const id = `cs_itest_saldo_${RUN}_${sesiones.size + 1}`
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
    // La devolución a la TARJETA (el otro destino) existe en este doble para la carrera; la de saldo nunca debe llamarla.
    refundSpy.mockReset()
    refundSpy.mockImplementation(async (_m: unknown, p: any) => {
      if (!enStripe.has(p.idempotencyKey))
        enStripe.set(p.idempotencyKey, {
          refundId: `re_saldo_${RUN}_${enStripe.size + 1}`,
          amount: p.amount,
          status: 'SUCCEEDED',
          metadata: p.metadata,
          pi: p.paymentIntentId,
        })
      const d = enStripe.get(p.idempotencyKey)!
      return { refundId: d.refundId, amount: d.amount, status: d.status }
    })
    getRefundSpy.mockReset()
    getRefundSpy.mockImplementation(async (_m: any, id: string) => {
      const d = [...enStripe.values()].find(x => x.refundId === id)!
      return { refundId: id, status: d.status, amountCents: d.amount, failureReason: null }
    })
    listRefundsSpy.mockReset()
    listRefundsSpy.mockImplementation(async (m: any, pi: string) => (await lecturaDelCargo(m, pi)).refunds)
    feeSpy.mockReset()
    feeSpy.mockResolvedValue(0)
    chargeRefundsSpy.mockReset()
    chargeRefundsSpy.mockImplementation(lecturaDelCargo)
    ;(logAction as jest.Mock).mockClear()
    // Lo de la prueba anterior de ESTA sucursal queda resuelto: sólo cuenta lo de cada prueba.
    await prisma.onlineOrderCharge.updateMany({ where: { ...v(), status: 'PENDING_AUTH' }, data: { status: 'ABANDONED' } })
    await prisma.onlineOrder.updateMany({ where: { ...v(), status: 'PENDING_ACCEPTANCE' }, data: { status: 'EXPIRED' } })
    await prisma.onlineOrder.updateMany({
      where: { ...v(), OR: [{ status: { in: ['ACCEPTED', 'READY'] } }, { status: 'COMPLETED', printedAt: null }] },
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

  afterAll(() => {
    for (const s of [checkoutSpy, authSpy, captureSpy, refundSpy, getRefundSpy, listRefundsSpy, feeSpy, chargeRefundsSpy]) s?.mockRestore()
    // La libreta no se borra (trigger): sobres, movimientos y lo que nombran se quedan en la base desechable de la corrida.
  })

  // ── El camino feliz ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  it('saldo: abona el 100 %, no llama a refunds.create y cierra el pedido COMPLETED con refundedAt; no reaparece tras syncPaidClosedFolios', async () => {
    const verificado = telefono()
    const ana = await clienta(verificado.slice(3)) // D661 (Ruling 57): su ficha sigue con el número que verificó (escrito distinto)
    const p = await cobrado(ana, verificado)

    const r = await devolver(p.orderId, 'STORE_CREDIT')
    expect(r).toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RESOLVED', replay: false })
    expect(refundSpy).not.toHaveBeenCalled()
    expect(chargeRefundsSpy).toHaveBeenCalledWith(expect.anything(), p.pi) // Ruling 28: se leyó el cargo antes

    // El sobre de la clienta: $250 con el teléfono que verificó al pagar, y su ACTIVATE ligado al renglón.
    const [sobre] = await sobresDe(ana)
    expect(sobre).toMatchObject({ status: 'ACTIVE', recipientPhone: verificado })
    expect(sobre.balance.toFixed(2)).toBe('250.00')
    const [mov] = await movimientosDe(p.orderId)
    expect(mov).toMatchObject({ type: 'ACTIVATE', giftCardId: sobre.id, refundPaymentId: r.refundId })

    // El pedido: «Devuelto» (COMPLETED + refundedAt), la venta como cualquier venta reembolsada; el cierre una vez.
    const oo = await enLinea(p.orderId)
    expect(oo).toMatchObject({ status: 'COMPLETED', notPickedUpAt: null })
    expect(oo.refundedAt).not.toBeNull()
    expect(oo.completedAt).toEqual(oo.refundedAt)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } })).toMatchObject({
      paymentStatus: 'PAID',
      kitchenPendingAt: null,
    })
    const [renglon] = await renglonesDe(p.orderId)
    expect(renglon.amount.toFixed(2)).toBe('-250.00')
    expect(await cierres(p.onlineOrderId)).toBe(1)
    expect(await efectosDe(p.orderId)).toBeGreaterThan(0) // comisión, referido, puntos y sello: encolados en la misma transacción
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ONLINE_ORDER_REFUNDED_TO_STORE_CREDIT', entityId: r.cardRefundId }),
    )
    // El panel y el MCP la ven como lo que es: a saldo a favor, sin Stripe ni reversa.
    expect(await listCardRefunds(venueId!, p.orderId)).toEqual([
      expect.objectContaining({ id: r.cardRefundId, status: 'RESOLVED', toStoreCredit: true, stripeRefundId: null, reversal: null }),
    ])

    // Nada lo revive: la pasada de folios cerrados, la bandeja y la lista de la caja.
    await syncPaidClosedFolios({ venueId: venueId! }, () => new Date())
    await listInbox({ venueId: venueId!, filter: 'all' })
    const folios = await listFolios({ venueId: venueId! })
    expect(folios.toDeliver.map(o => o.orderId)).not.toContain(p.orderId)
    expect(folios.tarjetasPorAbrir.map(o => o.orderId)).not.toContain(p.orderId)
    expect(folios.comandasPorImprimir.map(o => o.orderId)).not.toContain(p.orderId)
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'COMPLETED', refundedAt: oo.refundedAt })

    // El seguimiento (hand-over Task 4): una fila nacida RESOLVED y sin reversa dice SALDO.
    expect(await getTrackingByToken(p.trackingToken)).toMatchObject({
      status: 'COMPLETED',
      refundedAt: oo.refundedAt!.toISOString(),
      refund: { status: 'DONE', medio: 'SALDO' },
    })
  })

  it('saldo de un pedido ya entregado: queda COMPLETED con refundedAt (sin reserva) y la clienta recibe su saldo', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    await expect(markOnlineOrderDelivered({ venueId: venueId!, orderId: p.orderId, staffId: staffId! })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'COMPLETED',
    })
    const entregado = await enLinea(p.orderId)
    await expect(devolver(p.orderId, 'STORE_CREDIT')).resolves.toMatchObject({ cardRefundStatus: 'RESOLVED' })
    const oo = await enLinea(p.orderId)
    expect(oo).toMatchObject({ status: 'COMPLETED', completedAt: entregado.completedAt, refundRequestedAt: null })
    expect(oo.refundedAt).not.toBeNull()
    expect((await sobresDe(ana))[0].balance.toFixed(2)).toBe('250.00')
  })

  // ── Todo o nada (con la matriz r6 de la Task 6) ──────────────────────────────────────────────────────────────────────────────

  it('saldo: falla el cierre → se revierte el abono y el renglón (todo o nada)', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    const key = llave()
    // El cierre «Devuelto» (la ÚLTIMA escritura de la transacción) truena dentro de su propio CAS.
    const corte = cortarDentroDeLaTransaccion('onlineOrder', 'updateMany', a => a?.data?.refundedAt != null, 'murió en el cierre')
    try {
      await expect(devolver(p.orderId, 'STORE_CREDIT', { key })).rejects.toThrow('murió en el cierre')
      expect(corte.cortado()).toBe(true)
    } finally {
      corte.restaurar()
    }
    await nadaEscrito(p, ana)

    // El reintento (una llamada nueva con la misma llave) hace todo una sola vez.
    const r = await devolver(p.orderId, 'STORE_CREDIT', { key })
    expect(r).toMatchObject({ cardRefundStatus: 'RESOLVED', replay: false })
    expect(await movimientosDe(p.orderId)).toHaveLength(1)

    // Matriz r6: el renglón REFUND usa SALDO A FAVOR como medio, queda ligado a la fila RESOLVED, no mueve el cajón…
    const filas = await filasDe(p.chargeId)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ status: 'RESOLVED', toStoreCredit: true, refundPaymentId: r.refundId, stripeRefundId: null })
    const renglones = await renglonesDe(p.orderId)
    expect(renglones).toHaveLength(1)
    const renglon = renglones[0]
    expect(renglon.id).toBe(r.refundId)
    expect(renglon.tenderType?.systemKind).toBe('STORE_CREDIT')
    expect(renglon).toMatchObject({ fundsFlow: 'EXTERNAL_RECORDED', merchantAccountId: null, tenderSatFormaPago: '17' })
    const semantica = await prisma.payment.findUniqueOrThrow({ where: { id: renglon.id }, select: TENDER_SEMANTICS_SELECT })
    expect(paymentCountsAsDrawerCash(semantica)).toBe(false)
    expect(await prisma.cashDrawerEvent.count({ where: v() })).toBe(0)
    // … y el recorrido de Stripe no lo toma (ni por el sello pendiente: `nextCheckAt` nunca llega).
    expect(filas[0].nextCheckAt.getUTCFullYear()).toBe(9999)
    const tomadas = await recorridoDeEstaSucursal(new Date(Date.now() + 400 * 24 * 60 * MIN))
    expect(tomadas).not.toContain(filas[0].id)
    expect(refundSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['el abono al sobre', 'giftCardActivity', 'create', () => true],
    ['el renglón REFUND', 'payment', 'create', (a: any) => a?.data?.type === 'REFUND'],
    ['los efectos de la devolución', 'paymentEffect', 'createMany', () => true],
  ] as const)('todo o nada: si truena %s, no queda nada y el reintento lo hace una sola vez', async (_paso, modelo, metodo, cortar) => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    const key = llave()
    const corte = cortarDentroDeLaTransaccion(modelo, metodo, cortar, `murió en ${modelo}.${metodo}`)
    try {
      await expect(devolver(p.orderId, 'STORE_CREDIT', { key })).rejects.toThrow(`murió en ${modelo}.${metodo}`)
      expect(corte.cortado()).toBe(true)
    } finally {
      corte.restaurar()
    }
    await nadaEscrito(p, ana)
    await expect(devolver(p.orderId, 'STORE_CREDIT', { key })).resolves.toMatchObject({ cardRefundStatus: 'RESOLVED', replay: false })
    expect(await movimientosDe(p.orderId)).toHaveLength(1)
    expect(await renglonesDe(p.orderId)).toHaveLength(1)
    expect(await cierres(p.onlineOrderId)).toBe(1)
  })

  // ── Devolución hecha por fuera en Stripe (Ruling 28) ─────────────────────────────────────────────────────────────────────────

  it('saldo: devolución externa en Stripe (hecha o pendiente) → 409 y nada se abona', async () => {
    for (const [monto, estado] of [
      [25_000, 'SUCCEEDED'],
      [25_000, 'PENDING'],
      [5_000, 'SUCCEEDED'],
      [5_000, 'PENDING'],
    ] as const) {
      const ana = await clienta()
      const p = await cobrado(ana, telefono())
      porFuera(p.pi, monto, estado)
      await expect(devolver(p.orderId, 'STORE_CREDIT')).rejects.toMatchObject({
        statusCode: 409,
        code: 'EXTERNAL_REFUND_DETECTED',
        message: expect.stringMatching(/fuera de Avoqado[\s\S]*Stripe/),
      })
      await nadaEscrito(p, ana)
    }
    expect(refundSpy).not.toHaveBeenCalled()
  })

  it('Ruling 28 · tarjeta: devolución por fuera (100 % o parcial, hecha o pendiente) → 409 EXTERNAL_REFUND_DETECTED; nada se reserva ni se manda a Stripe', async () => {
    for (const [monto, estado] of [
      [25_000, 'SUCCEEDED'],
      [5_000, 'PENDING'],
    ] as const) {
      const ana = await clienta()
      const p = await cobrado(ana, telefono())
      porFuera(p.pi, monto, estado)
      await expect(devolver(p.orderId, 'CARD')).rejects.toMatchObject({ statusCode: 409, code: 'EXTERNAL_REFUND_DETECTED' })
      await nadaEscrito(p, ana)
    }
    expect(refundSpy).not.toHaveBeenCalled()
  })

  it('Ruling 28: si Stripe no contesta la lectura → 503 que se puede reintentar; nada se reserva, abona ni manda; al contestar, sí', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    const key = llave()
    chargeRefundsSpy.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    await expect(devolver(p.orderId, 'STORE_CREDIT', { key })).rejects.toMatchObject({
      statusCode: 503,
      code: 'STRIPE_REFUND_CHECK_UNAVAILABLE',
    })
    await nadaEscrito(p, ana)
    await expect(devolver(p.orderId, 'STORE_CREDIT', { key })).resolves.toMatchObject({ cardRefundStatus: 'RESOLVED' })
  })

  // ── El teléfono (r1 #6, r3 #6) ───────────────────────────────────────────────────────────────────────────────────────────────

  it('saldo: sobre con otro teléfono → STORE_CREDIT_PHONE_MISMATCH', async () => {
    const ana = await clienta()
    const primero = await cobrado(ana, telefono())
    await devolver(primero.orderId, 'STORE_CREDIT') // su sobre nace con el número que verificó ESA vez
    // Cambió de número en «Mi cuenta» y pagó verificando el nuevo: su ficha y su pago coinciden; el sobre, no.
    const nuevo = telefono()
    await prisma.customer.update({ where: { id: ana }, data: { phone: nuevo } })
    const segundo = await cobrado(ana, nuevo)
    await expect(devolver(segundo.orderId, 'STORE_CREDIT')).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORE_CREDIT_PHONE_MISMATCH',
      message: expect.stringContaining('tarjeta'),
    })
    await nadaEscrito(segundo, ana, 1)
    expect((await sobresDe(ana))[0].balance.toFixed(2)).toBe('250.00')
  })

  it('saldo: sobre existente y sin teléfono verificado → STORE_CREDIT_PHONE_MISMATCH', async () => {
    const ana = await clienta()
    const primero = await cobrado(ana, telefono())
    await devolver(primero.orderId, 'STORE_CREDIT')
    const segundo = await cobrado(ana, null) // su sesión de esta vez no probó teléfono
    await expect(devolver(segundo.orderId, 'STORE_CREDIT')).rejects.toMatchObject({ statusCode: 409, code: 'STORE_CREDIT_PHONE_MISMATCH' })
    await nadaEscrito(segundo, ana, 1)
  })

  it('saldo: el primer sobre nace con el teléfono verificado del pago, que sigue siendo el de su ficha (escrito distinto)', async () => {
    const verificado = telefono()
    const ana = await clienta(verificado.slice(3))
    const p = await cobrado(ana, verificado)
    await devolver(p.orderId, 'STORE_CREDIT')
    const [sobre] = await sobresDe(ana)
    expect(sobre.recipientPhone).toBe(verificado)
    // Y un segundo pedido verificado con el MISMO número recarga ese sobre (no abre otro).
    const segundo = await cobrado(ana, verificado)
    await devolver(segundo.orderId, 'STORE_CREDIT')
    const sobres = await sobresDe(ana)
    expect(sobres).toHaveLength(1)
    expect(sobres[0].balance.toFixed(2)).toBe('500.00')
  })

  it('D661 · Ruling 57: pagó verificando A y después cambió su número a B en «Mi cuenta»: el saldo a favor → 409 STORE_CREDIT_PHONE_MISMATCH y nada se escribe (tampoco un sobre); a su tarjeta, sí', async () => {
    const a = telefono()
    const ana = await clienta(a)
    const p = await cobrado(ana, a)
    await prisma.customer.update({ where: { id: ana }, data: { phone: telefono() } }) // perdió A y verificó B
    await expect(devolver(p.orderId, 'STORE_CREDIT')).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORE_CREDIT_PHONE_MISMATCH',
      message: expect.stringMatching(/otro teléfono[\s\S]*tarjeta/),
    })
    await nadaEscrito(p, ana)
    await expect(devolver(p.orderId, 'CARD')).resolves.toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RECORDED' })
  })

  it('saldo: sin teléfono verificado y sin sobre → STORE_CREDIT_CUSTOMER_PHONE_REQUIRED', async () => {
    const ana = await clienta(telefono()) // la ficha de hoy sí tiene número: no cuenta
    const p = await cobrado(ana, null)
    await expect(devolver(p.orderId, 'STORE_CREDIT')).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_CUSTOMER_PHONE_REQUIRED',
      message: expect.stringContaining('tarjeta'),
    })
    await nadaEscrito(p, ana)
    // A la tarjeta sí se puede.
    await expect(devolver(p.orderId, 'CARD')).resolves.toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RECORDED' })
  })

  // ── Repetir y competir ───────────────────────────────────────────────────────────────────────────────────────────────────────

  it('saldo dos veces con la misma llave → un abono', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    const key = llave()
    const expected = null
    // A la vez (dos pestañas con la misma llave) y otra vez después (la app murió tras el commit y reenvía).
    const [a, b] = await Promise.all([
      devolver(p.orderId, 'STORE_CREDIT', { key, expected }),
      devolver(p.orderId, 'STORE_CREDIT', { key, expected }),
    ])
    const c = await devolver(p.orderId, 'STORE_CREDIT', { key, expected })
    expect(new Set([a.cardRefundId, b.cardRefundId, c.cardRefundId]).size).toBe(1)
    expect([a.replay, b.replay].sort()).toEqual([false, true])
    expect(c).toMatchObject({ replay: true, refundId: a.refundId, cardRefundStatus: 'RESOLVED' })
    expect(await movimientosDe(p.orderId)).toHaveLength(1)
    expect(await renglonesDe(p.orderId)).toHaveLength(1)
    expect((await sobresDe(ana))[0].balance.toFixed(2)).toBe('250.00')
    expect(await cierres(p.onlineOrderId)).toBe(1)
  })

  it('saldo y tarjeta a la vez → una gana y la otra 409 CARD_REFUND_STALE_VIEW', async () => {
    for (let i = 0; i < 4; i++) {
      const ana = await clienta()
      const p = await cobrado(ana, telefono())
      const [saldo, tarjeta] = await Promise.allSettled([
        devolver(p.orderId, 'STORE_CREDIT', { expected: null }),
        devolver(p.orderId, 'CARD', { expected: null }),
      ])
      const ganadas = [saldo, tarjeta].filter(x => x.status === 'fulfilled')
      const perdidas = [saldo, tarjeta].filter(x => x.status === 'rejected') as PromiseRejectedResult[]
      expect({ i, ganadas: ganadas.length }).toEqual({ i, ganadas: 1 })
      expect(perdidas[0].reason).toMatchObject({ statusCode: 409, code: 'CARD_REFUND_STALE_VIEW' })
      // Un solo destino: una fila, un renglón; el saldo sólo si ganó el saldo.
      expect(await filasDe(p.chargeId)).toHaveLength(1)
      expect(await renglonesDe(p.orderId)).toHaveLength(1)
      expect(await movimientosDe(p.orderId)).toHaveLength(saldo.status === 'fulfilled' ? 1 : 0)
      expect(refundSpy).toHaveBeenCalledTimes(tarjeta.status === 'fulfilled' ? 1 : 0)
      refundSpy.mockClear()
    }
  })

  // ── El recorrido de Stripe y el cierre compartido ────────────────────────────────────────────────────────────────────────────

  /** El recorrido REAL de cada minuto, con su consulta acotada a esta sucursal; devuelve los ids de las filas que tomó. */
  const recorridoDeEstaSucursal = async (ahora: Date) => {
    const leer = prisma.onlineOrderCardRefund.findMany.bind(prisma.onlineOrderCardRefund)
    const tomadas: string[] = []
    const espia = jest.spyOn(prisma.onlineOrderCardRefund, 'findMany').mockImplementation((async (a: any) => {
      const filas = await leer({ ...a, where: { AND: [a.where, v()] } })
      if (a.select?.status) tomadas.push(...filas.map((f: any) => f.id)) // la primera consulta: las filas que el recorrido avanza
      return filas
    }) as any)
    try {
      await sweepCardRefunds(ahora, read => read())
    } finally {
      espia.mockRestore()
    }
    return tomadas
  }

  it('una fila de saldo nunca la toma el barrido de Stripe', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    const r = await devolver(p.orderId, 'STORE_CREDIT')
    const fila = (await filasDe(p.chargeId))[0]
    // C3: nace con la reversa del sello ya sellada (el efecto quedó encolado en su misma transacción): el barrido no tiene nada que hacer.
    expect(fila).toMatchObject({ id: r.cardRefundId, status: 'RESOLVED', toStoreCredit: true, stampReversedAt: expect.any(Date) })
    expect(fila.stampReversedAt).toEqual(fila.recordedAt)
    for (const dias of [0, 1, 31, 400]) {
      expect(await recorridoDeEstaSucursal(new Date(Date.now() + dias * 24 * 60 * MIN))).not.toContain(fila.id)
    }
    // El recorrido sí avanza las filas a la TARJETA de otras pruebas de esta sucursal; a la de saldo nunca la toca ni la manda.
    expect(refundSpy).not.toHaveBeenCalled()
    // Ni una escritura: la fila sigue idéntica (sin lastError, sin nueva revisión, sin tocar).
    expect(await prisma.onlineOrderCardRefund.findUniqueOrThrow({ where: { id: fila.id } })).toEqual(fila)

    // C3: aunque alguien le pusiera otra vez una revisión vencida, la rama de las selladas (REVERSED/RESOLVED sin sello) no la toma.
    await prisma.onlineOrderCardRefund.update({ where: { id: fila.id }, data: { nextCheckAt: new Date(Date.now() - MIN) } })
    expect(await recorridoDeEstaSucursal(new Date())).not.toContain(fila.id)
    expect(refundSpy).not.toHaveBeenCalled()

    // C4 (control positivo): una devolución a la TARJETA con su revisión vencida SÍ la toma el mismo recorrido.
    const q = await cobrado(await clienta(), telefono())
    const aTarjeta = await devolver(q.orderId, 'CARD')
    await prisma.onlineOrderCardRefund.update({
      where: { id: aTarjeta.cardRefundId },
      data: { status: 'PENDING', nextCheckAt: new Date(Date.now() - MIN) },
    })
    expect(await recorridoDeEstaSucursal(new Date())).toContain(aTarjeta.cardRefundId)
  })

  it('cerrarComoDevueltoEnTx sobre un pedido reservado cuya devolución sigue pendiente no lo cierra', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    // Una devolución a la tarjeta reservada y todavía sin renglón (Stripe la dejó PENDING).
    refundSpy.mockImplementationOnce(async (_m: unknown, prm: any) => {
      enStripe.set(prm.idempotencyKey, {
        refundId: `re_pend_${RUN}`,
        amount: prm.amount,
        status: 'PENDING',
        metadata: prm.metadata,
        pi: prm.paymentIntentId,
      })
      return { refundId: `re_pend_${RUN}`, amount: prm.amount, status: 'PENDING' }
    })
    await expect(devolver(p.orderId, 'CARD')).resolves.toMatchObject({ status: 'PENDING' })
    const reservado = await enLinea(p.orderId)
    expect(reservado.refundRequestedAt).not.toBeNull()

    const cierre = await prisma.$transaction(tx => cerrarComoDevueltoEnTx(tx, { venueId: venueId!, orderId: p.orderId, now: new Date() }))
    expect(cierre).toEqual({ cerrado: false })
    expect(await enLinea(p.orderId)).toMatchObject({ status: 'ACCEPTED', refundedAt: null, refundRequestedAt: reservado.refundRequestedAt })
    expect(await cierres(p.onlineOrderId)).toBe(0)
  })

  it('seguimiento: el medio sale de lo que la fila REGISTRÓ, nunca de toStoreCredit (una reversa pagada por transferencia dice TRANSFERENCIA)', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    // Una fila marcada a saldo pero que en realidad terminó en una reversa resuelta por transferencia (forzado a mano).
    const fila = await prisma.onlineOrderCardRefund.create({
      data: {
        ...v(),
        chargeId: p.chargeId,
        key: llave(),
        amountCents: 25_000,
        reason: 'CANCELLED_ORDER',
        staffId: staffId!,
        requestHash: `hash-${RUN}-${seq}`,
        status: 'RESOLVED',
        toStoreCredit: true,
        nextCheckAt: new Date('9999-12-31T00:00:00.000Z'),
      },
    })
    await prisma.onlineOrderCardRefundReversal.create({
      data: {
        ...v(),
        cardRefundId: fila.id,
        stripeRefundId: `re_rev_${RUN}`,
        amountCents: 25_000,
        feeCents: 0,
        detectedAt: new Date(),
        resolvedMethod: 'BANK_TRANSFER',
        resolvedAt: new Date(),
      },
    })
    expect((await getTrackingByToken(p.trackingToken))?.refund).toEqual({ status: 'DONE', medio: 'TRANSFERENCIA' })
  })

  it('D661 · B3: saldo de un «No lo recogió» con su comanda reclamada → 409 PRINT_IN_FLIGHT y no se abona nada; sin reclamo vigente, abona y cierra «Devuelto» (ya no pide papel)', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    const corte = new Date()
    await prisma.onlineOrder.update({
      where: { id: p.onlineOrderId },
      data: { status: 'COMPLETED', completedAt: corte, notPickedUpAt: corte },
    })
    const porImprimir = async () => (await listFolios(v())).comandasPorImprimir.map(c => c.orderId)
    expect(await porImprimir()).toContain(p.orderId)
    await expect(claimOnlineOrderPrint(venueId!, p.orderId, 'caja-1')).resolves.toEqual({ claimed: true })

    await expect(devolver(p.orderId, 'STORE_CREDIT')).rejects.toMatchObject({ statusCode: 409, code: 'PRINT_IN_FLIGHT' })
    expect(await filasDe(p.chargeId)).toHaveLength(0)
    expect(await movimientosDe(p.orderId)).toHaveLength(0)
    expect(await renglonesDe(p.orderId)).toHaveLength(0)
    expect(await enLinea(p.orderId)).toMatchObject({ refundRequestedAt: null, refundedAt: null })

    // El reclamo venció sin confirmarse (la caja murió): ya no hay papel en vuelo; se abona y se cierra en una sola transacción.
    await prisma.onlineOrder.update({ where: { id: p.onlineOrderId }, data: { printClaimedAt: new Date(Date.now() - 2 * MIN) } })
    await expect(devolver(p.orderId, 'STORE_CREDIT')).resolves.toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RESOLVED' })
    const oo = await enLinea(p.orderId)
    expect(oo.status).toBe('COMPLETED')
    expect(oo.refundedAt).not.toBeNull()
    expect(await porImprimir()).not.toContain(p.orderId)
  })

  // ── Ronda codex-r2 (20-nov) ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('D661 · D (Ruling 44): saldo de un «No lo recogió» con un reclamo VIVO ganado 10 s antes de cerrar la ventana de 2 h → 1 s después, 409 PRINT_IN_FLIGHT y no se abona nada; confirmado el papel, abona y cierra «Devuelto»', async () => {
    const ana = await clienta()
    const p = await cobrado(ana, telefono())
    // El corte fue hace 2 h + 1 s (la ventana ya no admite reclamos NUEVOS) y una caja ganó el suyo 10 s antes de que cerrara.
    const corte = new Date(Date.now() - NO_LO_RECOGIO_PAPEL_MS - 1000)
    await prisma.onlineOrder.update({
      where: { id: p.onlineOrderId },
      data: { status: 'COMPLETED', completedAt: corte, notPickedUpAt: corte },
    })
    const reclamo = new Date(corte.getTime() + NO_LO_RECOGIO_PAPEL_MS - 10_000)
    await expect(claimOnlineOrderPrint(venueId!, p.orderId, 'caja-1', reclamo)).resolves.toEqual({ claimed: true })

    await expect(devolver(p.orderId, 'STORE_CREDIT')).rejects.toMatchObject({ statusCode: 409, code: 'PRINT_IN_FLIGHT' })
    expect(await filasDe(p.chargeId)).toHaveLength(0)
    expect(await renglonesDe(p.orderId)).toHaveLength(0)
    expect(await movimientosDe(p.orderId)).toHaveLength(0)
    expect(await sobresDe(ana)).toHaveLength(0)
    expect(await efectosDe(p.orderId)).toBe(0)
    expect(await enLinea(p.orderId)).toMatchObject({ refundRequestedAt: null, refundedAt: null })

    // La caja confirma el papel: ya no hay comanda en vuelo; se abona y se cierra «Devuelto» en una sola transacción.
    await expect(confirmOnlineOrderPrinted(venueId!, p.orderId, 'caja-1')).resolves.toEqual({ ok: true })
    await expect(devolver(p.orderId, 'STORE_CREDIT')).resolves.toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RESOLVED' })
    expect((await enLinea(p.orderId)).refundedAt).not.toBeNull()
    expect(await sobresDe(ana)).toHaveLength(1)
  })
})
