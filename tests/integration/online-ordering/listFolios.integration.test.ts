// tests/integration/online-ordering/listFolios.integration.test.ts
/**
 * Integration (REAL DB) — tienda híbrida T12: la lista de la caja contra Postgres. Los filtros de «Por pagar» (R16, R41, R42) y de
 * «Por entregar», y que lo cobrado pase a «Por entregar» en el mismo sondeo (R43).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { getTrackingByToken } from '@/services/online-ordering/order.service'
import { listFolios } from '@/services/online-ordering/folios.service'
import { expireOnlineOrder, markOnlineOrderDelivered, markOnlineOrderReady } from '@/services/online-ordering/transitions.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigirBaseDesechable, type Fixture } from '../payments/webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn(async () => undefined) }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))

let f: Fixture
let productId: string

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('t12lista')
  // Un negocio con pantalla de cocina: así cada cobro que salda (y `prepararFolioPagado`) marca la cocina, y se puede contar.
  await prisma.printStation.create({
    data: {
      venueId: f.venueId,
      name: 'Cocina',
      isDefault: true,
      hasKitchenDisplay: true,
      kitchenDisplaySince: new Date(Date.now() - 24 * 3_600_000),
    },
  })
  // Un renglón sin producto es importe libre y no va a la cocina (`planKitchenTickets`): el folio vende un producto del catálogo.
  const categoria = await prisma.menuCategory.create({ data: { venueId: f.venueId, name: 'Antojitos', slug: `antojitos-${f.fixture}` } })
  productId = (
    await prisma.product.create({
      data: { venueId: f.venueId, name: 'Flautas', sku: `FLA-${f.fixture}`, price: 100, categoryId: categoria.id, availableOnline: true },
    })
  ).id
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(socketManager.getServer as jest.Mock).mockReturnValue({ sockets: { sockets: new Map() }, to: () => ({ emit: jest.fn() }) })
  ;(terminalRegistry.getTerminal as jest.Mock).mockReturnValue(undefined)
})
afterEach(async () => {
  const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout> | undefined
  for (const t of programadas?.values() ?? []) clearTimeout(t)
  programadas?.clear()
  await prisma.kdsOrderItem.deleteMany({ where: { kdsOrder: { venueId: f.venueId } } })
  await prisma.kdsOrder.deleteMany({ where: { venueId: f.venueId } })
  await prisma.paymentEffect.deleteMany({ where: { venueId: f.venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.notification.deleteMany({ where: { venueId: f.venueId } })
  await prisma.posSyncIntent.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
  await prisma.customer.deleteMany({ where: { venueId: f.venueId } })
})
afterAll(async () => {
  if (!f) return
  await prisma.onlineOrderingSettings.deleteMany({ where: { venueId: f.venueId } })
  await prisma.printStation.deleteMany({ where: { venueId: f.venueId } })
  await prisma.product.deleteMany({ where: { venueId: f.venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId: f.venueId } })
  await f.destruir()
})

const CIEN = 10_000 // $100.00 en centavos (la cuenta de cada folio)
const CINCUENTA = 5_000

/** Un folio de «Nadie» (o un pedido de «Mi equipo»), con la forma de `writeOnlineOrderInTx`: cuenta WEB de $100 y un renglón. */
async function nuevoFolio(o: { equipo?: boolean; vencido?: boolean } = {}) {
  const orden = await prisma.order.create({
    data: {
      venueId: f.venueId,
      orderNumber: `F-${randomUUID().slice(0, 8)}`,
      type: 'PICKUP',
      source: 'WEB',
      originSystem: 'AVOQADO',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 100,
      discountAmount: 0,
      taxAmount: 0,
      tipAmount: 0,
      total: 100,
      paidAmount: 0,
      remainingBalance: 100,
      customerName: 'Ana ITEST',
      items: {
        create: [
          { productId, productName: 'Flautas', quantity: 1, unitPrice: 100, discountAmount: 0, taxAmount: 0, total: 100, sequence: 0 },
        ],
      },
    },
  })
  const pedido = await prisma.onlineOrder.create({
    data: {
      orderId: orden.id,
      venueId: f.venueId,
      status: 'PENDING_ACCEPTANCE',
      paymentMode: 'PAY_AT_PICKUP',
      trackingToken: `${randomUUID()}${randomUUID()}`.replace(/-/g, ''),
      acceptDeadlineAt: o.vencido ? new Date(Date.now() - 60_000) : new Date(Date.now() + 30 * 60_000),
      requiresAcceptance: o.equipo === true,
      channel: o.equipo ? null : 'QR',
    },
  })
  return { orderId: orden.id, onlineOrderId: pedido.id }
}

const efectivoDeLaTpv = (orderId: string, centavos: number) =>
  recordOrderPayment(
    f.venueId,
    orderId,
    {
      ...f.registroDeLaTerminal({ attemptId: randomUUID(), sinMerchant: true, amount: centavos }),
      method: 'CASH',
      authorizationNumber: undefined,
    },
    f.staffId,
  )

const numeros = (xs: Array<{ orderId: string }>) => xs.map(x => x.orderId)

describe('T12 · listFolios contra Postgres', () => {
  it('Por pagar: sin dinero y con abono (PARTIAL, con su remaining); una cuenta cancelada no sale; lo cobrado pasa a Por entregar en el mismo sondeo', async () => {
    const sinDinero = await nuevoFolio()
    const conAbono = await nuevoFolio()
    const cancelado = await nuevoFolio()
    const cobrado = await nuevoFolio()
    const entregado = await nuevoFolio()
    const deEquipo = await nuevoFolio({ equipo: true })

    await efectivoDeLaTpv(conAbono.orderId, CINCUENTA)
    await prisma.order.update({ where: { id: cancelado.orderId }, data: { status: 'CANCELLED' } })
    await efectivoDeLaTpv(cobrado.orderId, CIEN)
    await efectivoDeLaTpv(entregado.orderId, CIEN)
    await listFolios({ venueId: f.venueId })
    await markOnlineOrderDelivered({ venueId: f.venueId, orderId: entregado.orderId, staffId: f.staffId })

    const r = await listFolios({ venueId: f.venueId })

    expect(numeros(r.toPay)).toEqual([sinDinero.orderId, conAbono.orderId])
    expect(r.toPay[1]).toMatchObject({ paymentStatus: 'PARTIAL', remaining: 50, total: 100, paidAt: null })
    // R79: con un abono el seguimiento público dice cuánto se pagó y cuánto falta (pesos, sin reembolsos)
    const tokenAbono = (await prisma.onlineOrder.findUniqueOrThrow({ where: { id: conAbono.onlineOrderId } })).trackingToken
    expect(await getTrackingByToken(tokenAbono)).toMatchObject({ paid: false, paidAt: null, amountPaid: 50, remaining: 50, total: 100 })
    const tokenSin = (await prisma.onlineOrder.findUniqueOrThrow({ where: { id: sinDinero.onlineOrderId } })).trackingToken
    expect(await getTrackingByToken(tokenSin)).toMatchObject({ amountPaid: 0, remaining: 100 })
    // T18c: precios por renglón en la misma lectura de la página
    expect(r.toPay[0].items[0]).toMatchObject({ name: 'Flautas', quantity: 1, unitPrice: 100, total: 100 })
    // T18b: el folio saldado trae la hora del cobro real (Payment COMPLETED), en la misma lectura de la página
    const cobro = await prisma.payment.findFirstOrThrow({ where: { orderId: cobrado.orderId, status: 'COMPLETED' } })
    expect(r.toDeliver[0].paidAt).toBe(cobro.createdAt.toISOString())
    expect(r.counts).toEqual({ toPay: 2, toDeliver: 1 })
    expect(numeros(r.toDeliver)).toEqual([cobrado.orderId])
    expect(r).toMatchObject({ showTile: true, nextCursors: { toPay: null, toDeliver: null } })
    // el pedido de «Mi equipo» nunca es folio
    expect(numeros([...r.toPay, ...r.toDeliver])).not.toContain(deEquipo.orderId)
    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: cancelado.onlineOrderId } })).status).toBe('CANCELLED_BY_STAFF')
  })

  it('T18b: paidAt es la hora del COBRO aunque después haya un reembolso COMPLETED; el seguimiento público trae nombre, paidAt y precios por renglón', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    const antes = await getTrackingByToken(
      (await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).trackingToken,
    )
    expect(antes).toMatchObject({ paid: false, paidAt: null, customerName: 'Ana ITEST' })

    await efectivoDeLaTpv(orderId, CIEN)
    const cobro = await prisma.payment.findFirstOrThrow({ where: { orderId, status: 'COMPLETED', type: { not: 'REFUND' } } })
    // un reembolso COMPLETED posterior (negativo) NO puede volverse «la hora de pago»
    const { id: _id, createdAt: _c, updatedAt: _u, ...resto } = cobro as any
    await prisma.payment.create({
      data: {
        ...resto,
        idempotencyKey: null,
        type: 'REFUND',
        amount: -cobro.amount,
        createdAt: new Date(cobro.createdAt.getTime() + 60_000),
      },
    })

    const token = (await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).trackingToken
    const t = await getTrackingByToken(token)
    expect(t).toMatchObject({ paid: true, paidAt: cobro.createdAt.toISOString(), customerName: 'Ana ITEST', total: 100 })
    expect(t!.items[0]).toMatchObject({ name: 'Flautas', quantity: 1, unitPrice: 100, total: 100 })
    const r = await listFolios({ venueId: f.venueId })
    expect(r.toDeliver.find(x => x.orderId === orderId)?.paidAt).toBe(cobro.createdAt.toISOString())
  })

  it('T18b: un cobro con Payment.type NULL (filas históricas) también da paidAt', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio()
    await efectivoDeLaTpv(orderId, CIEN)
    const cobro = await prisma.payment.findFirstOrThrow({ where: { orderId, status: 'COMPLETED' } })
    await prisma.payment.update({ where: { id: cobro.id }, data: { type: null } })
    const token = (await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).trackingToken
    expect(await getTrackingByToken(token)).toMatchObject({ paid: true, paidAt: cobro.createdAt.toISOString() })
    const r = await listFolios({ venueId: f.venueId })
    expect(r.toDeliver.find(x => x.orderId === orderId)?.paidAt).toBe(cobro.createdAt.toISOString())
  })

  it('un folio que el dinero tardío pasó a ACCEPTED sale en toDeliver', async () => {
    const { orderId, onlineOrderId } = await nuevoFolio({ vencido: true })
    expect(await expireOnlineOrder({ venueId: f.venueId, orderId })).toMatchObject({ outcome: 'OK', status: 'EXPIRED' })
    await efectivoDeLaTpv(orderId, CIEN) // el dinero llega después de vencer

    const r = await listFolios({ venueId: f.venueId })

    expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: onlineOrderId } })).status).toBe('ACCEPTED')
    expect(numeros(r.toDeliver)).toEqual([orderId])
    expect(r.toPay).toEqual([])
    expect(r.counts).toEqual({ toPay: 0, toDeliver: 1 })
  })

  it('«Listo» NO lo saca de toDeliver (sigue pagado y sin entregar, con su status); «Entregado» sí; un COMPLETED no sale', async () => {
    const { orderId } = await nuevoFolio()
    await efectivoDeLaTpv(orderId, CIEN)
    expect(numeros((await listFolios({ venueId: f.venueId })).toDeliver)).toEqual([orderId])

    await expect(markOnlineOrderReady({ venueId: f.venueId, orderId, staffId: f.staffId })).resolves.toMatchObject({ outcome: 'OK' })

    const r = await listFolios({ venueId: f.venueId })
    expect(r.toDeliver.map(x => [x.orderId, x.status])).toEqual([[orderId, 'READY']])
    expect(r.counts.toDeliver).toBe(1)

    await markOnlineOrderDelivered({ venueId: f.venueId, orderId, staffId: f.staffId })
    const fin = await listFolios({ venueId: f.venueId })
    expect(fin.toDeliver).toEqual([])
    expect(fin.counts.toDeliver).toBe(0)
  })

  it('paginación con ACCEPTED y READY mezclados: sigue por (createdAt, id), sin saltar ni repetir aunque uno pase de ACCEPTED a READY entre páginas', async () => {
    const ids: string[] = []
    for (let i = 0; i < 101; i++) {
      const { orderId } = await nuevoFolio()
      await efectivoDeLaTpv(orderId, CIEN)
      ids.push(orderId)
    }
    // la sincronización de pagados es acotada por pasada: se corren dos para que los 101 queden en «Por entregar»
    await listFolios({ venueId: f.venueId })
    await listFolios({ venueId: f.venueId })
    const p1 = await listFolios({ venueId: f.venueId, section: 'toDeliver' })
    expect(p1.toDeliver).toHaveLength(100)
    expect(p1.counts.toDeliver).toBe(101)
    // entre páginas: uno de la página siguiente (el 101) y uno de la ya leída pasan a «Listo»
    await markOnlineOrderReady({ venueId: f.venueId, orderId: ids[100], staffId: f.staffId })
    await markOnlineOrderReady({ venueId: f.venueId, orderId: ids[0], staffId: f.staffId })
    const p2 = await listFolios({ venueId: f.venueId, section: 'toDeliver', cursor: p1.nextCursors.toDeliver! })
    expect(p2.toDeliver.map(x => x.orderId)).toEqual([ids[100]])
    expect(p2.toDeliver[0].status).toBe('READY')
    const vistos = [...p1.toDeliver, ...p2.toDeliver].map(x => x.orderId)
    expect(new Set(vistos).size).toBe(101)
  })
})
