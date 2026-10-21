/**
 * Integration (REAL DB + REAL app por supertest) — Tarea 14 del KDS de Uber: «no tengo este
 * artículo» (spec §3.3) y su reintento humano (§3.5).
 *
 * 🔴 El dinero NO se mueve con el 2xx del retiro: lo mueve la reconciliación (T13) cuando la foto
 * fresca del proveedor ya no trae el renglón. Aquí el proveedor se simula en el adaptador REAL
 * (`resolveFulfillmentIssues`, `fetchOrder`, `normalizeOrder` espiados): nunca se pega a Uber.
 */
import { DeliveryChannelLink, DeliveryProvider, OrderSource, OrderStatus, OrderType, Prisma, StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { env } from '@/config/env'
import * as candado from '@/services/delivery-channels/core/deliveryOrderLock'
import * as lineRemoval from '@/services/delivery-channels/core/lineRemoval.service'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import * as reconciliacion from '@/services/delivery-channels/core/deliveryReconciliation.service'
import type { ActionResult, NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '@/services/delivery-channels/core/types'
import { DeliveryWriteNotSentError } from '@/services/delivery-channels/core/types'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import * as uberToken from '@/services/delivery-channels/providers/uber-eats/uber.token'
import { bloquearOrdenParaFacturar } from '@/services/fiscal/admisionIva'
import { listDeliveryLineActions } from '@/services/mobile/kdsOutOfStock.mobile.service'

// El rastro de un resultado tardío se lee en la base: aquí `logAction` es el REAL (el setup lo mockea).
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))

jest.setTimeout(30_000)

// The barrier tests below hold real row locks and delete fixtures: only on an explicitly isolated local database.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}

const QUINCE_MIN = 15 * 60_000

describe('«No tengo este artículo» desde el KDS (Tarea 14)', () => {
  let venueId: string, venueIdOtro: string, orgId: string, staffId: string, viewerId: string
  let link: DeliveryChannelLink
  let token: string, tokenOtro: string, tokenViewer: string
  let n = 0
  let resolver: jest.SpyInstance
  let leerPedido: jest.SpyInstance

  const pago = (venta: string): NormalizedDeliveryPayment => ({
    currency: 'MXN',
    saleAmount: venta,
    merchantFees: '0.00',
    tipAmount: '0.00',
    externallyPaidSale: venta,
    externallyPaidTip: '0.00',
    cashDueSale: '0.00',
    cashDueTip: '0.00',
  })

  /** Un pedido de reparto de dos renglones (a: $150, b: $50) como lo deja la ingesta real. */
  async function sembrar({ aceptado = true }: { aceptado?: boolean } = {}) {
    const sufijo = ++n
    const renglon = (linea: string, nombre: string, precio: string) => ({
      externalId: `${linea}-${sufijo}`,
      lineId: linea,
      name: `${nombre} ${sufijo}`,
      quantity: 1,
      unitPrice: precio,
      total: precio,
    })
    const normalized: NormalizedDeliveryOrder = {
      externalId: `oos-${Date.now()}-${sufijo}`,
      displayId: `OS${sufijo}`,
      source: OrderSource.UBER_EATS,
      items: [renglon('a', 'Cochinita', '150.00'), renglon('b', 'Horchata', '50.00')],
      payment: pago('200.00'),
      customer: { name: 'Cliente T14' },
      raw: { fuente: 'test' },
      placedAt: new Date(),
      providerAccepted: aceptado,
    }
    const { order } = await ingestDeliveryOrder(normalized, link)
    const kds = await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: order.id } })
    const itemB = await prisma.kdsOrderItem.findFirstOrThrow({ where: { kdsOrderId: kds.id, externalLineId: 'b' } })
    /** La foto del proveedor con los renglones que SIGUEN. */
    const foto = (siguen: string[], venta: string, extra: Partial<NormalizedDeliveryOrder> = {}): NormalizedDeliveryOrder => ({
      ...normalized,
      items: normalized.items.filter(i => siguen.includes(i.lineId!)),
      payment: pago(venta),
      ...extra,
    })
    return { order, kds, itemB, foto, externalOrderId: normalized.externalId }
  }

  const url = (v: string, kdsId: string, itemId: string) => `/api/v1/mobile/venues/${v}/kds/orders/${kdsId}/items/${itemId}/out-of-stock`
  const retirar = (kdsId: string, itemId: string, tok = token, v = venueId) =>
    request(app)
      .post(url(v, kdsId, itemId))
      .set('Authorization', `Bearer ${tok}`)
  const reintentar = (kdsId: string, itemId: string, expectedAttempt: number) =>
    request(app)
      .post(`${url(venueId, kdsId, itemId)}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedAttempt })

  const accionDe = (orderId: string, lineId = 'b') => prisma.deliveryLineAction.findFirst({ where: { orderId, lineId } })
  const proveedorDevuelve = (foto: NormalizedDeliveryOrder) => leerPedido.mockResolvedValue(foto)

  /** Un intento del cajero, sembrado como lo dejaría la ruta (o el barrido), con la hora que haga falta. */
  const sembrarAccion = (
    order: { id: string; externalId: string | null },
    orderItemId: string,
    datos: { status: string; attempts: number; lastAttemptAt: Date; lineId?: string },
  ) =>
    prisma.deliveryLineAction.create({
      data: {
        venueId,
        orderId: order.id,
        orderItemId,
        provider: DeliveryProvider.UBER_EATS,
        externalOrderId: order.externalId!.split(':')[1],
        storeId: link.externalLocationId,
        lineId: datos.lineId ?? 'b',
        action: 'REMOVE_ITEM',
        status: datos.status,
        origin: 'STAFF',
        requestedByStaffId: staffId,
        attempts: datos.attempts,
        lastAttemptAt: datos.lastAttemptAt,
      },
    })

  /** Una respuesta de Uber que la prueba suelta cuando quiere. */
  const diferida = () => {
    let soltar!: (r: ActionResult) => void
    const promesa = new Promise<ActionResult>(res => (soltar = res))
    return { promesa, soltar }
  }
  const hasta = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 25))
    if (!cond()) throw new Error('la condición nunca se cumplió')
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org oos ${Date.now()}`, email: `oos${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V oos ${Date.now()}`, slug: `v-oos-${Date.now()}` } })).id
    venueIdOtro = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `V oos-otro ${Date.now()}`, slug: `v-oos-otro-${Date.now()}` } })
    ).id
    link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: DeliveryProvider.UBER_EATS, externalLocationId: `store-oos-${Date.now()}`, webhookSecret: 'x' },
    })

    staffId = (await prisma.staff.create({ data: { email: `oos-staff-${Date.now()}@t.mx`, firstName: 'KDS', lastName: 'Retiro' } })).id
    viewerId = (await prisma.staff.create({ data: { email: `oos-viewer-${Date.now()}@t.mx`, firstName: 'Solo', lastName: 'Mira' } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    await prisma.staffVenue.create({ data: { staffId, venueId: venueIdOtro, role: StaffRole.OWNER, active: true } })
    await prisma.staffVenue.create({ data: { staffId: viewerId, venueId, role: StaffRole.VIEWER, active: true } })
    const firmar = (sub: string, v: string, role: StaffRole) =>
      jwt.sign({ sub, orgId, venueId: v, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
    token = firmar(staffId, venueId, StaffRole.OWNER)
    tokenOtro = firmar(staffId, venueIdOtro, StaffRole.OWNER)
    tokenViewer = firmar(viewerId, venueId, StaffRole.VIEWER)
  })

  beforeEach(() => {
    // Nunca la red real: cada prueba que llega a Uber dice qué contesta.
    resolver = jest.spyOn(uberAdapter, 'resolveFulfillmentIssues').mockRejectedValue(new Error('respuesta de Uber no configurada'))
    // Por defecto la foto del proveedor no se puede leer (READ_FAILED): ni la recuperación de la
    // aceptación ni la reconciliación salen a la red de verdad.
    leerPedido = jest.spyOn(uberAdapter, 'fetchOrder').mockRejectedValue(new Error('sin red en la prueba'))
    jest.spyOn(uberAdapter, 'normalizeOrder').mockImplementation(raw => raw as NormalizedDeliveryOrder)
    // La ingesta AUTO dispara un accept en segundo plano: tampoco sale a la red.
    jest.spyOn(uberAdapter, 'acceptOrder').mockRejectedValue(new Error('sin red en la prueba'))
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      const venues = [venueId, venueIdOtro]
      const ids = (await prisma.order.findMany({ where: { venueId: { in: venues } }, select: { id: true } })).map(o => o.id)
      const pagos = (await prisma.payment.findMany({ where: { venueId: { in: venues } }, select: { id: true } })).map(p => p.id)
      await prisma.deliveryLineAction.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.venueTransaction.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.paymentEffect.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: pagos } } })
      await prisma.payment.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.kdsOrder.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.venueTenderType.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
      await prisma.staffVenue.deleteMany({ where: { staffId: { in: [staffId, viewerId] } } })
      await prisma.venue.deleteMany({ where: { id: { in: venues } } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: { in: [staffId, viewerId] } } })
    } catch {
      /* fixtures */
    }
  })

  // ── Precondiciones, en el ORDEN exacto del spec §3.3 (pasos 1 y 3) ─────────────────────────
  type Semilla = Awaited<ReturnType<typeof sembrar>>
  // 5 elementos SIEMPRE: con 4, jest-each toma el 5º parámetro del callback por `done` y cuelga.
  it.each<[string, number, string | undefined, (s: Semilla) => Promise<unknown>, { aceptado?: boolean; venue?: 'otro' }]>([
    ['comanda de otro venue', 404, undefined, async () => undefined, { venue: 'otro' }],
    [
      'sin orderItemId',
      409,
      'LINE_ID_MISSING',
      s => prisma.kdsOrderItem.update({ where: { id: s.itemB.id }, data: { orderItemId: null } }),
      {},
    ],
    [
      'orden que no es DELIVERY',
      409,
      'NOT_DELIVERY',
      s => prisma.order.update({ where: { id: s.order.id }, data: { type: OrderType.DINE_IN } }),
      {},
    ],
    [
      'link no resoluble',
      409,
      'LINK_UNRESOLVED',
      s => prisma.order.update({ where: { id: s.order.id }, data: { deliveryChannelLinkId: 'link-que-no-existe' } }),
      {},
    ],
    [
      'proveedor sin capacidad',
      409,
      'UNSUPPORTED_PROVIDER',
      // Se BORRA la capacidad (el espía del beforeEach la tiene); `restoreAllMocks` la devuelve.
      async () => {
        delete (uberAdapter as Partial<typeof uberAdapter>).resolveFulfillmentIssues
      },
      {},
    ],
    [
      'sin providerAcceptedAt',
      409,
      'NOT_ACCEPTED',
      async s => proveedorDevuelve(s.foto(['a', 'b'], '200.00', { providerAccepted: false })),
      { aceptado: false },
    ],
    [
      'con readyReportedAt',
      409,
      'ALREADY_READY',
      s => prisma.order.update({ where: { id: s.order.id }, data: { readyReportedAt: new Date() } }),
      {},
    ],
    [
      'reserva tomada por READY',
      409,
      'DELIVERY_OP_IN_PROGRESS',
      s =>
        prisma.order.update({
          where: { id: s.order.id },
          data: { deliveryOpInFlight: 'READY', deliveryOpInFlightAt: new Date(), deliveryOpToken: 'de-otro' },
        }),
      {},
    ],
    [
      'otra accion PENDING en la orden',
      409,
      'LINE_ACTION_IN_PROGRESS',
      async s => {
        const a = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'a' } })
        return sembrarAccion(s.order, a.id, { status: 'PENDING', attempts: 1, lastAttemptAt: new Date(), lineId: 'a' })
      },
      {},
    ],
  ])('%s ⇒ %i %s', async (_caso, status, code, preparar, opts) => {
    const s = await sembrar({ aceptado: opts.aceptado ?? true })
    await preparar(s)

    const res = opts.venue === 'otro' ? await retirar(s.kds.id, s.itemB.id, tokenOtro, venueIdOtro) : await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(status)
    if (code) expect(res.body.code).toBe(code)
    expect(resolver).not.toHaveBeenCalled()
    // Sin operación nueva: ni acción de línea sobre `b`, ni reserva tomada por el retiro.
    expect(await accionDe(s.order.id)).toBeNull()
    const o = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })
    expect(o.deliveryOpInFlight).not.toBe('REMOVE_ITEM')
  })

  it('sin providerAcceptedAt hace UNA sola lectura al proveedor antes de negar', async () => {
    const s = await sembrar({ aceptado: false })
    proveedorDevuelve(s.foto(['a', 'b'], '200.00', { providerAccepted: false }))

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.body.code).toBe('NOT_ACCEPTED')
    expect(leerPedido).toHaveBeenCalledTimes(1)
  })

  it('AUTO aceptado sólo por state=ACCEPTED (2xx perdido) SÍ permite el retiro', async () => {
    const s = await sembrar({ aceptado: false })
    proveedorDevuelve(s.foto(['a', 'b'], '200.00', { providerAccepted: true }))
    resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(200)
    expect(resolver).toHaveBeenCalledTimes(1)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })
    expect(o.providerAcceptedEvidence).toBe('PROVIDER_STATE')
  })

  it('un VIEWER sin orders:update recibe 403 (CASHIER sí trae orders:update de fábrica)', async () => {
    const s = await sembrar()
    const res = await retirar(s.kds.id, s.itemB.id, tokenViewer)
    expect(res.status).toBe(403)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('2xx de Uber ⇒ 200 con el renglon tachado; el dinero lo mueve la reconciliación, y repetir es idempotente', async () => {
    const s = await sembrar()
    resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })
    proveedorDevuelve(s.foto(['a'], '150.00', { providerAccepted: true }))

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(200)
    expect(resolver).toHaveBeenCalledWith(s.externalOrderId, link.externalLocationId, ['b'])
    const renglon = res.body.data.items.find((i: { id: string }) => i.id === s.itemB.id)
    expect(renglon.productName.startsWith('RETIRADO · ')).toBe(true)
    expect(await accionDe(s.order.id)).toMatchObject({
      status: 'CONFIRMED',
      origin: 'STAFF',
      requestedByStaffId: staffId,
      attempts: 1,
      providerStatus: 200,
      settlement: 'REFUNDED',
    })
    const [refund] = await prisma.payment.findMany({ where: { orderId: s.order.id, type: 'REFUND' } })
    expect(refund.amount.toString()).toBe('-50')
    expect(await prisma.activityLog.count({ where: { entityId: s.order.id, action: 'DELIVERY_ITEM_REMOVED', staffId } })).toBe(1)

    const otra = await retirar(s.kds.id, s.itemB.id)
    expect(otra.status).toBe(200)
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(await prisma.payment.count({ where: { orderId: s.order.id, type: 'REFUND' } })).toBe(1)
  })

  it('2xx y la reconciliación LANZA ⇒ la ruta responde igual con la comanda; la liquidación queda pendiente', async () => {
    const s = await sembrar()
    resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })
    jest.spyOn(reconciliacion, 'reconcileDeliveryOrderFromProvider').mockRejectedValue(new Error('Transaction already closed'))

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(200)
    const renglon = res.body.data.items.find((i: { id: string }) => i.id === s.itemB.id)
    expect(renglon.productName.startsWith('RETIRADO · ')).toBe(true)
    expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', settlement: 'PENDING' })
    expect(await prisma.payment.count({ where: { orderId: s.order.id, type: 'REFUND' } })).toBe(0)
  })

  it('timeout de Uber ⇒ 202 UNCERTAIN y CERO reenvios', async () => {
    const s = await sembrar()
    resolver.mockRejectedValue(new Error('timeout of 10000ms exceeded'))

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(202)
    expect(res.body.data).toMatchObject({ state: 'UNCERTAIN', attempts: 1 })
    expect(new Date(res.body.data.canRetryAt).getTime() - new Date(res.body.data.since).getTime()).toBe(QUINCE_MIN)
    const otra = await retirar(s.kds.id, s.itemB.id)
    expect(otra.status).toBe(202)
    expect(resolver).toHaveBeenCalledTimes(1)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })
    expect(o.deliveryOpInFlight).toBeNull() // la reserva se limpia en finally
  })

  // ── Fallo ANTES de la red (candado, su lectura a la base, token): no hay nada en duda ────────
  /**
   * El adaptador REAL hasta `fetch` (sustituido): así el fallo nace donde nace en producción —el
   * candado de escrituras de la Tarea 19— y no en un espía. El env se restaura al terminar.
   */
  async function conUberReal<T>(ambiente: Record<string, unknown>, cuerpo: (red: jest.SpyInstance) => Promise<T>): Promise<T> {
    const antes: Record<string, unknown> = {}
    for (const k of Object.keys(ambiente)) antes[k] = (env as Record<string, unknown>)[k]
    Object.assign(env, ambiente)
    resolver.mockRestore()
    jest.spyOn(uberToken, 'getUberAppToken').mockResolvedValue('token-de-prueba')
    const red = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    try {
      return await cuerpo(red)
    } finally {
      Object.assign(env, antes)
    }
  }
  const PROD = { UBER_ENVIRONMENT: 'PRODUCTION', UBER_CLIENT_ID_PRODUCTION: 'cid-oos', UBER_CLIENT_SECRET_PRODUCTION: 'secreto-oos' }

  it('el candado no se pudo leer (base caída) ⇒ 503, sin intento colgado; el pedido no queda bloqueado', async () => {
    const s = await sembrar()
    await conUberReal(PROD, async red => {
      const real = prisma.deliveryChannelLink.findMany.bind(prisma.deliveryChannelLink)
      jest
        .spyOn(prisma.deliveryChannelLink, 'findMany')
        .mockImplementation(((args: { where?: Record<string, unknown> }) =>
          args?.where && 'ownerAuthorizedEnvironment' in args.where
            ? Promise.reject(new Error('conexión perdida'))
            : real(args as never)) as never)

      const res = await retirar(s.kds.id, s.itemB.id)

      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({
        code: 'PROVIDER_NOT_CONTACTED',
        error: 'No se pudo contactar a Uber; no se envió nada, intenta de nuevo.',
      })
      expect(red).not.toHaveBeenCalled()
    })
    expect(await accionDe(s.order.id)).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpInFlight).toBeNull()
    // Nada quedó en duda: un pedido nuevo abre otro intento y sale.
    jest.spyOn(uberAdapter, 'resolveFulfillmentIssues').mockResolvedValue({ ok: true, status: 200, raw: '{}' })
    const otra = await retirar(s.kds.id, s.itemB.id)
    expect(otra.status).toBe(200)
    expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1 })
  })

  it('tienda sin consentimiento (Uber desconectada) ⇒ 409 STORE_NOT_CONNECTED, nunca REJECTED', async () => {
    const s = await sembrar()
    await conUberReal(PROD, async red => {
      const res = await retirar(s.kds.id, s.itemB.id)

      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({
        code: 'STORE_NOT_CONNECTED',
        error: 'Uber está desconectada para esta tienda; reconéctala desde el panel.',
      })
      expect(red).not.toHaveBeenCalled()
    })
    expect(await accionDe(s.order.id)).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpInFlight).toBeNull()
  })

  it('un timeout REAL de la red sigue en duda: 202 UNCERTAIN, sin reenvío', async () => {
    const s = await sembrar()
    await conUberReal(
      {
        UBER_ENVIRONMENT: 'SANDBOX',
        UBER_CLIENT_ID_SANDBOX: 'cid-oos-sbx',
        UBER_CLIENT_SECRET_SANDBOX: 'secreto-oos-sbx',
        UBER_WRITABLE_STORE_IDS_SANDBOX: link.externalLocationId,
      },
      async red => {
        red.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))

        const res = await retirar(s.kds.id, s.itemB.id)

        expect(res.status).toBe(202)
        expect(res.body.data).toMatchObject({ state: 'UNCERTAIN', attempts: 1 })
        expect(red).toHaveBeenCalledTimes(1)
      },
    )
  })

  it('un reintento que no salió vuelve a UNCERTAIN con su intento anterior ⇒ 503', async () => {
    const s = await sembrar()
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })
    const antes = new Date(Date.now() - QUINCE_MIN - 60_000)
    await sembrarAccion(s.order, item.id, { status: 'UNCERTAIN', attempts: 1, lastAttemptAt: antes })
    resolver.mockRejectedValue(new DeliveryWriteNotSentError('UNAVAILABLE', 'No se envió nada a Uber: token'))

    const res = await reintentar(s.kds.id, s.itemB.id, 1)

    expect(res.status).toBe(503)
    expect(resolver).toHaveBeenCalledTimes(1)
    const a = (await accionDe(s.order.id))!
    expect(a).toMatchObject({ status: 'UNCERTAIN', attempts: 1, retriedByStaffId: null })
    expect(a.lastAttemptAt.getTime()).toBe(antes.getTime())
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpInFlight).toBeNull()
  })

  it('409 de Uber con "already been marked ready" ⇒ REJECTED', async () => {
    const s = await sembrar()
    resolver.mockResolvedValue({ ok: false, status: 409, raw: '{"message":"cannot modify order that has already been marked ready"}' })

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ code: 'PROVIDER_REJECTED', reason: 'ALREADY_READY' })
    expect(await accionDe(s.order.id)).toMatchObject({ status: 'REJECTED', providerStatus: 409 })
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })).removedAt).toBeNull()
  })

  it('409 de Uber sin causa acreditada ⇒ UNCERTAIN', async () => {
    const s = await sembrar()
    resolver.mockResolvedValue({ ok: false, status: 409, raw: '{"message":"conflict"}' })

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(202)
    expect(res.body.data.state).toBe('UNCERTAIN')
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it.each([
    [400, 502, 'REJECTED'],
    [404, 502, 'REJECTED'],
    [408, 202, 'UNCERTAIN'],
    [429, 202, 'UNCERTAIN'],
    [503, 202, 'UNCERTAIN'],
  ])('Uber contesta %i ⇒ %i %s, sin reenvío', async (uber, http, estado) => {
    const s = await sembrar()
    resolver.mockResolvedValue({ ok: false, status: uber, raw: '{"message":"x"}' })

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(http)
    expect((await accionDe(s.order.id))?.status).toBe(estado)
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('dos cajeros a la vez sobre el MISMO renglón ⇒ un solo aviso a Uber; el segundo ve el intento en curso (202)', async () => {
    const s = await sembrar()
    const uber = diferida()
    resolver.mockReturnValue(uber.promesa)

    const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
    await hasta(() => resolver.mock.calls.length === 1)
    const segundo = await retirar(s.kds.id, s.itemB.id)
    uber.soltar({ ok: true, status: 200, raw: '{}' })
    const uno = await primero

    expect(segundo.status).toBe(202)
    expect(segundo.body.data.state).toBe('PENDING')
    expect(uno.status).toBe(200)
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('dos cajeros a la vez sobre renglones DISTINTOS ⇒ uno sale a Uber y el otro recibe 409 IN_PROGRESS', async () => {
    const s = await sembrar()
    const itemA = await prisma.kdsOrderItem.findFirstOrThrow({ where: { kdsOrderId: s.kds.id, externalLineId: 'a' } })
    const uber = diferida()
    resolver.mockReturnValue(uber.promesa)

    const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
    await hasta(() => resolver.mock.calls.length === 1)
    const segundo = await retirar(s.kds.id, itemA.id)
    uber.soltar({ ok: false, status: 503, raw: 'caido' })
    const uno = await primero

    expect(segundo.status).toBe(409)
    expect(segundo.body.code).toBe('DELIVERY_OP_IN_PROGRESS')
    expect(uno.status).toBe(202)
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('una respuesta TARDIA del intento 1 no toca el intento 2 (CAS attempts)', async () => {
    const s = await sembrar()
    const uber1 = diferida()
    const uber2 = diferida()
    resolver.mockReturnValueOnce(uber1.promesa).mockReturnValueOnce(uber2.promesa)

    // Intento 1 se queda colgado en Uber…
    const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
    await hasta(() => resolver.mock.calls.length === 1)
    // …el barrido lo pasa a UNCERTAIN, su reserva vence, y 15 min después alguien reintenta.
    const accion = (await accionDe(s.order.id))!
    await prisma.deliveryLineAction.update({
      where: { id: accion.id },
      data: { status: 'UNCERTAIN', lastAttemptAt: new Date(Date.now() - QUINCE_MIN - 60_000) },
    })
    await prisma.order.update({ where: { id: s.order.id }, data: { deliveryOpInFlightAt: new Date(Date.now() - 3 * 60_000) } })
    const segundo = reintentar(s.kds.id, s.itemB.id, 1).then(r => r)
    await hasta(() => resolver.mock.calls.length === 2)

    // Llega el 2xx del intento 1: ya no es el intento vigente.
    uber1.soltar({ ok: true, status: 200, raw: '{}' })
    await primero
    const aMitad = (await accionDe(s.order.id))!
    expect(aMitad).toMatchObject({ status: 'PENDING', attempts: 2, retriedByStaffId: staffId })
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })).removedAt).toBeNull()
    expect(await prisma.activityLog.count({ where: { entityId: s.order.id, action: 'DELIVERY_OP_LATE_RESULT' } })).toBe(1)

    // El intento 2 decide.
    uber2.soltar({ ok: false, status: 503, raw: 'caido' })
    const dos = await segundo
    expect(dos.status).toBe(202)
    expect(dos.body.data).toMatchObject({ state: 'UNCERTAIN', attempts: 2 })
  })

  it('2xx con la reserva ya en manos de OTRA operación ⇒ la acción queda CONFIRMED pero el pedido NO se marca (§3.2(c))', async () => {
    const s = await sembrar()
    const uber = diferida()
    resolver.mockReturnValue(uber.promesa)

    const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
    await hasta(() => resolver.mock.calls.length === 1)
    // Mientras Uber contesta, otra operación se queda con la reserva (el intento sigue siendo el 1).
    await prisma.order.update({
      where: { id: s.order.id },
      data: { deliveryOpInFlight: 'READY', deliveryOpInFlightAt: new Date(), deliveryOpToken: 'de-otra-operacion' },
    })
    uber.soltar({ ok: true, status: 200, raw: '{}' })
    const res = await primero

    expect(res.status).toBe(200)
    expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1 })
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })).removedAt).toBeNull()
    expect(await prisma.activityLog.count({ where: { entityId: s.order.id, action: 'DELIVERY_OP_LATE_RESULT' } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpToken).toBe('de-otra-operacion')
  })

  it('la respuesta de un intento que YA no es el vigente (con la reserva aún propia) queda en el log, no se tira en silencio', async () => {
    const s = await sembrar()
    const uber = diferida()
    resolver.mockReturnValue(uber.promesa)
    ;(logger.warn as jest.Mock).mockClear()

    const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
    await hasta(() => resolver.mock.calls.length === 1)
    // El barrido lo pasó a UNCERTAIN mientras Uber contestaba; la reserva sigue siendo nuestra.
    await prisma.deliveryLineAction.updateMany({ where: { orderId: s.order.id, lineId: 'b' }, data: { status: 'UNCERTAIN' } })
    uber.soltar({ ok: false, status: 503, raw: 'caido' })
    const res = await primero

    expect(res.status).toBe(202)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ya no es el vigente'),
      expect.objectContaining({ attempt: 1, status: 503 }),
    )
    expect(await prisma.activityLog.count({ where: { entityId: s.order.id, action: 'DELIVERY_OP_LATE_RESULT' } })).toBe(0)
  })

  it('un reintento que LANZA tras su CAS se deshace: vuelve a UNCERTAIN con su intento anterior, sin rastro de RETRIED', async () => {
    const s = await sembrar()
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })
    const antes = new Date(Date.now() - QUINCE_MIN - 60_000)
    await sembrarAccion(s.order, item.id, { status: 'UNCERTAIN', attempts: 1, lastAttemptAt: antes })
    jest.spyOn(candado, 'tomarReserva').mockRejectedValueOnce(new Error('se cayó la base a media apertura'))

    const res = await reintentar(s.kds.id, s.itemB.id, 1)

    expect(res.status).toBe(500)
    expect(resolver).not.toHaveBeenCalled()
    const a = (await accionDe(s.order.id))!
    expect(a).toMatchObject({ status: 'UNCERTAIN', attempts: 1, retriedByStaffId: null })
    expect(a.lastAttemptAt.getTime()).toBe(antes.getTime())
    await new Promise(r => setTimeout(r, 200)) // el log de RETRIED es fire-and-forget: se le da tiempo de aparecer
    expect(await prisma.activityLog.count({ where: { entityId: s.order.id, action: 'DELIVERY_ITEM_REMOVAL_RETRIED' } })).toBe(0)
  })

  it('la comanda devuelta calcula needsAcceptance IGUAL que el tablero (pedido MANUAL aún PENDING)', async () => {
    const s = await sembrar()
    // Aceptado desde la tableta de Uber (PROVIDER_STATE) pero la venta sigue PENDING en Avoqado.
    await prisma.order.update({ where: { id: s.order.id }, data: { status: OrderStatus.PENDING } })
    resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })

    const res = await retirar(s.kds.id, s.itemB.id)
    const tablero = await request(app).get(`/api/v1/mobile/venues/${venueId}/kds/orders`).set('Authorization', `Bearer ${token}`)
    const enTablero = tablero.body.data.find((k: { id: string }) => k.id === s.kds.id)

    expect(res.status).toBe(200)
    expect(res.body.data.needsAcceptance).toBe(true)
    expect(res.body.data.needsAcceptance).toBe(enTablero.needsAcceptance)
    expect(res.body.data.needsPrint).toBe(enTablero.needsPrint)
  })

  it.each([
    ['PENDING', 'Espera: se está retirando otro artículo de este pedido; intenta en unos segundos.'],
    ['UNCERTAIN', 'Otro artículo de este pedido espera confirmación de la app de reparto; reintenta ése primero.'],
  ])('otro artículo %s en el pedido ⇒ 409 LINE_ACTION_IN_PROGRESS con el texto que lo explica', async (estado, texto) => {
    const s = await sembrar()
    const a = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'a' } })
    await sembrarAccion(s.order, a.id, { status: estado, attempts: 1, lastAttemptAt: new Date(), lineId: 'a' })

    const res = await retirar(s.kds.id, s.itemB.id)

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'LINE_ACTION_IN_PROGRESS', error: texto })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('retry con expectedAttempt viejo ⇒ 409 RETRY_NOT_ELIGIBLE', async () => {
    const s = await sembrar()
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })
    await sembrarAccion(s.order, item.id, { status: 'UNCERTAIN', attempts: 2, lastAttemptAt: new Date(Date.now() - QUINCE_MIN - 60_000) })

    const res = await reintentar(s.kds.id, s.itemB.id, 1)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('RETRY_NOT_ELIGIBLE')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('retry antes de canRetryAt ⇒ 409 RETRY_NOT_ELIGIBLE', async () => {
    const s = await sembrar()
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })
    await sembrarAccion(s.order, item.id, { status: 'UNCERTAIN', attempts: 1, lastAttemptAt: new Date(Date.now() - 5 * 60_000) })

    const res = await reintentar(s.kds.id, s.itemB.id, 1)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('RETRY_NOT_ELIGIBLE')
    expect(resolver).not.toHaveBeenCalled()
    expect(await accionDe(s.order.id)).toMatchObject({ status: 'UNCERTAIN', attempts: 1 })
  })

  it('retry cuando la linea YA no esta ⇒ CONFIRMED sin reenviar', async () => {
    const s = await sembrar()
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })
    await sembrarAccion(s.order, item.id, { status: 'UNCERTAIN', attempts: 1, lastAttemptAt: new Date(Date.now() - QUINCE_MIN - 60_000) })
    proveedorDevuelve(s.foto(['a'], '150.00', { providerAccepted: true }))

    const res = await reintentar(s.kds.id, s.itemB.id, 1)

    expect(res.status).toBe(200)
    expect(resolver).not.toHaveBeenCalled()
    expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', settlement: 'REFUNDED' })
    const renglon = res.body.data.items.find((i: { id: string }) => i.id === s.itemB.id)
    expect(renglon.productName.startsWith('RETIRADO · ')).toBe(true)
  })

  it('retry cuya precondición ya no se cumple NO deja un intento colgado: se deshace', async () => {
    const s = await sembrar()
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })
    const antes = new Date(Date.now() - QUINCE_MIN - 60_000)
    await sembrarAccion(s.order, item.id, { status: 'UNCERTAIN', attempts: 1, lastAttemptAt: antes })
    await prisma.order.update({ where: { id: s.order.id }, data: { readyReportedAt: new Date() } })

    const res = await reintentar(s.kds.id, s.itemB.id, 1)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALREADY_READY')
    expect(resolver).not.toHaveBeenCalled()
    const a = (await accionDe(s.order.id))!
    expect(a).toMatchObject({ status: 'UNCERTAIN', attempts: 1 })
    expect(a.lastAttemptAt.getTime()).toBe(antes.getTime())
  })

  it('el MCP ve el estado de los retiros del venue (sólo lectura)', async () => {
    const s = await sembrar()
    resolver.mockRejectedValue(new Error('timeout'))
    await retirar(s.kds.id, s.itemB.id)

    const vista = await listDeliveryLineActions(venueId, { orderId: s.order.id })

    expect(vista).toEqual({
      items: [
        expect.objectContaining({
          orderId: s.order.id,
          lineId: 'b',
          status: 'UNCERTAIN',
          attempts: 1,
          settlement: 'PENDING',
          reconcileBlocked: null,
        }),
      ],
      hasMore: false,
      nextCursor: null,
      total: 1,
      blockedOrders: [],
      blockedOrdersTotal: 0,
      blockedOrdersNextCursor: null,
    })
    // Otro negocio no ve nada: ni los retiros ni que la orden exista.
    expect(await listDeliveryLineActions(venueIdOtro, { orderId: s.order.id })).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
      total: 0,
      blockedOrders: [],
      blockedOrdersTotal: 0,
      blockedOrdersNextCursor: null,
    })
  })

  // ── Plan 3b: the answer is applied under delivery advisory → Order, the lock fiscal admission also takes ─────────
  describe('Plan 3b — applying the provider answer under the delivery advisory → Order lock', () => {
    const barrera = () => {
      let soltar!: () => void
      const promesa = new Promise<void>(res => (soltar = res))
      return { promesa, soltar }
    }
    /** Some connection is waiting on a lock whose query matches `patron` (never a sleep). */
    const esperarBloqueo = async (patron = '%"Order"%') => {
      for (let i = 0; i < 150; i++) {
        const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query ILIKE ${patron}`
        if (n > 0) return
        await new Promise(r => setTimeout(r, 20))
      }
      throw new Error(`No connection waited on ${patron}`)
    }
    /** Real fiscal admission holds the Order; `cambio` runs in its tx right before it commits. */
    const retenerOrden = (orderId: string, cambio: (tx: Prisma.TransactionClient) => Promise<unknown> = async () => undefined) => {
      const dentro = barrera(),
        salir = barrera()
      const listo = prisma.$transaction(
        async tx => {
          await bloquearOrdenParaFacturar(tx, orderId)
          dentro.soltar()
          await salir.promesa
          await cambio(tx)
        },
        { timeout: 20_000 },
      )
      return { dentro: dentro.promesa, soltar: salir.soltar, listo }
    }
    const renglonB = (orderId: string) => prisma.orderItem.findFirstOrThrow({ where: { orderId, externalLineId: 'b' } })
    const retiros = (orderId: string) => prisma.activityLog.count({ where: { entityId: orderId, action: 'DELIVERY_ITEM_REMOVED' } })
    /** The 2xx lands while fiscal admission holds the Order (with `cambio` committed by it); returns the route's answer. */
    async function aplicarMientrasFiscalRetiene(s: Semilla, cambio?: (tx: Prisma.TransactionClient) => Promise<unknown>) {
      const uber = diferida()
      resolver.mockReturnValue(uber.promesa)
      const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
      await hasta(() => resolver.mock.calls.length === 1)
      const fiscal = retenerOrden(s.order.id, cambio)
      try {
        await fiscal.dentro
        uber.soltar({ ok: true, status: 200, raw: '{}' })
        await esperarBloqueo()
      } finally {
        fiscal.soltar()
        await fiscal.listo
      }
      return primero
    }

    it('fiscal admission first: the apply waits on the Order and then marks the line once', async () => {
      const s = await sembrar()

      const res = await aplicarMientrasFiscalRetiene(s)

      expect(res.status).toBe(200)
      expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1, providerStatus: 200 })
      expect((await renglonB(s.order.id)).removedAt).not.toBeNull()
      expect(await retiros(s.order.id)).toBe(1)
    })

    it('an order moved to another venue while the apply waited is not touched; our action keeps the provider answer (T5-R2)', async () => {
      const s = await sembrar()
      ;(logger.warn as jest.Mock).mockClear()

      const res = await aplicarMientrasFiscalRetiene(s, tx =>
        tx.order.update({ where: { id: s.order.id }, data: { venueId: venueIdOtro } }),
      )

      expect(res.status).toBe(200)
      expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1, providerStatus: 200 })
      expect((await renglonB(s.order.id)).removedAt).toBeNull()
      expect(await retiros(s.order.id)).toBe(0)
      // Our own token is released even though the order is now another venue's.
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpToken).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('ya no es de este negocio'),
        expect.objectContaining({ orderId: s.order.id, venueId, orderItemId: s.itemB.orderItemId, attempt: 1 }),
      )
    })

    it('a cancellation committed while the apply waited does not stop the mark: once, action CONFIRMED (T5-R1)', async () => {
      const s = await sembrar()

      const res = await aplicarMientrasFiscalRetiene(s, tx =>
        tx.order.update({ where: { id: s.order.id }, data: { status: OrderStatus.CANCELLED } }),
      )

      expect(res.status).toBe(200)
      expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1 })
      expect((await renglonB(s.order.id)).removedAt).not.toBeNull()
      expect(await retiros(s.order.id)).toBe(1)
      // The money side still leaves a cancelled sale alone (pre-existing; Plan 4): no compensation.
      expect(await prisma.payment.count({ where: { orderId: s.order.id, type: 'REFUND' } })).toBe(0)
    })

    it('with the reservation already taken by another operation, the apply still waits for fiscal admission', async () => {
      const s = await sembrar()
      const uber = diferida()
      resolver.mockReturnValue(uber.promesa)

      const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
      await hasta(() => resolver.mock.calls.length === 1)
      await prisma.order.update({
        where: { id: s.order.id },
        data: { deliveryOpInFlight: 'READY', deliveryOpInFlightAt: new Date(), deliveryOpToken: 'de-otra-operacion' },
      })
      const fiscal = retenerOrden(s.order.id)
      try {
        await fiscal.dentro
        uber.soltar({ ok: true, status: 200, raw: '{}' })
        await esperarBloqueo()
        // While fiscal admission holds the Order nothing of the apply is visible.
        expect(await accionDe(s.order.id)).toMatchObject({ status: 'PENDING', attempts: 1 })
      } finally {
        fiscal.soltar()
        await fiscal.listo
      }
      const res = await primero

      expect(res.status).toBe(200)
      expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1 })
      expect((await renglonB(s.order.id)).removedAt).toBeNull()
      expect(await prisma.activityLog.count({ where: { entityId: s.order.id, action: 'DELIVERY_OP_LATE_RESULT' } })).toBe(1)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpToken).toBe('de-otra-operacion')
    })

    it('the apply holds the Order until fiscal admission can read the complete removal', async () => {
      const s = await sembrar()
      resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })
      const marcado = barrera(),
        seguir = barrera()
      const original = lineRemoval.applyLineRemoval
      jest.spyOn(lineRemoval, 'applyLineRemoval').mockImplementationOnce(async (tx, p) => {
        await original(tx, p)
        marcado.soltar()
        await seguir.promesa
      })
      const vista = (db: Prisma.TransactionClient) =>
        Promise.all([
          db.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' }, select: { removedAt: true } }),
          db.kdsOrderItem.findUniqueOrThrow({ where: { id: s.itemB.id }, select: { removedAt: true, productName: true } }),
          db.deliveryLineAction.findFirst({ where: { orderId: s.order.id, lineId: 'b' }, select: { status: true, attempts: true } }),
          db.activityLog.count({ where: { entityId: s.order.id, action: 'DELIVERY_ITEM_REMOVED' } }),
        ])

      const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
      let fiscal: ReturnType<typeof vista> | undefined
      try {
        await Promise.race([
          marcado.promesa,
          primero.then(() => {
            throw new Error('the apply never marked the line')
          }),
        ])
        fiscal = prisma.$transaction(async tx => {
          await bloquearOrdenParaFacturar(tx, s.order.id)
          return vista(tx)
        })
        await esperarBloqueo()
      } finally {
        seguir.soltar()
        await primero
      }

      expect((await primero).status).toBe(200)
      const final = await vista(prisma)
      expect(await fiscal!).toEqual(final)
      expect(final[0].removedAt).not.toBeNull()
      expect(final[1].productName.startsWith('RETIRADO · ')).toBe(true)
      expect(final[2]).toMatchObject({ status: 'CONFIRMED', attempts: 1 })
      expect(final[3]).toBe(1)
    })

    it('a failure after the line was marked rolls the whole apply back; the reservation is still released', async () => {
      const s = await sembrar()
      resolver.mockResolvedValue({ ok: true, status: 200, raw: '{}' })
      const original = lineRemoval.applyLineRemoval
      let visto = false
      jest.spyOn(lineRemoval, 'applyLineRemoval').mockImplementationOnce(async (tx, p) => {
        await original(tx, p)
        visto = (await tx.orderItem.findFirstOrThrow({ where: { orderId: s.order.id, externalLineId: 'b' } })).removedAt !== null
        throw new Error('injected failure after the line was marked')
      })

      const res = await retirar(s.kds.id, s.itemB.id)

      expect(res.status).toBe(500)
      expect(visto).toBe(true)
      expect(await accionDe(s.order.id)).toMatchObject({ status: 'PENDING', attempts: 1 })
      expect((await renglonB(s.order.id)).removedAt).toBeNull()
      expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: s.itemB.id } })).removedAt).toBeNull()
      expect(await retiros(s.order.id)).toBe(0)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } })).deliveryOpToken).toBeNull()
    })

    it('two markers of the same line: the apply queued behind a webhook reconciliation does not mark it twice', async () => {
      const s = await sembrar()
      const uber = diferida()
      resolver.mockReturnValue(uber.promesa)
      let entregarFoto!: (foto: NormalizedDeliveryOrder) => void

      const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
      await hasta(() => resolver.mock.calls.length === 1)
      // A webhook reconciliation takes the delivery advisory and is reading Uber: its photo no longer has line b.
      leerPedido.mockReturnValue(new Promise(res => (entregarFoto = res)))
      const webhook = reconciliacion.reconcileDeliveryOrderFromProvider(s.order.id, { trigger: 'WEBHOOK' })
      await hasta(() => leerPedido.mock.calls.length === 1)
      uber.soltar({ ok: true, status: 200, raw: '{}' })
      // The route's apply queues on the same delivery advisory.
      await esperarBloqueo('%pg_advisory_xact_lock%')
      entregarFoto(s.foto(['a'], '150.00', { providerAccepted: true }))
      const r = await webhook
      const res = await primero

      expect(r.outcome).toBe('REFUNDED')
      expect(res.status).toBe(200)
      expect(await retiros(s.order.id)).toBe(1)
      expect(await prisma.payment.count({ where: { orderId: s.order.id, type: 'REFUND' } })).toBe(1)
      expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1 })
    })

    it('an order deleted while Uber answered: soft outcome, no throw, our action keeps the provider answer (T5-R2)', async () => {
      const s = await sembrar()
      const uber = diferida()
      resolver.mockReturnValue(uber.promesa)
      ;(logger.warn as jest.Mock).mockClear()

      const primero = retirar(s.kds.id, s.itemB.id).then(r => r)
      await hasta(() => resolver.mock.calls.length === 1)
      // Venue or demo teardown deletes the sale while Uber answers.
      await prisma.paymentAllocation.deleteMany({ where: { orderId: s.order.id } })
      await prisma.order.delete({ where: { id: s.order.id } })
      uber.soltar({ ok: true, status: 200, raw: '{}' })
      const res = await primero

      expect(res.status).toBe(200)
      expect(await accionDe(s.order.id)).toMatchObject({ status: 'CONFIRMED', attempts: 1, providerStatus: 200 })
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('ya no es de este negocio'),
        expect.objectContaining({ orderId: s.order.id, venueId }),
      )
    })
  })
})
