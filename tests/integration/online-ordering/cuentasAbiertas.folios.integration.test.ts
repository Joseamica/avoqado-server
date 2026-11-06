// tests/integration/online-ordering/folios.integration.test.ts
/**
 * Integration (REAL DB) — tienda híbrida T11: las listas de «cuentas abiertas» de la TPV y del POS no muestran folios por pagar.
 *
 * Llama a las dos listas REALES: un folio por pagar no sale; un folio vencido con abono tardío sí; un pedido de «Mi equipo» en
 * `PENDING_ACCEPTANCE` sigue saliendo como hoy.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { listOrders } from '@/services/mobile/order.mobile.service'
import { expireOnlineOrder } from '@/services/online-ordering/transitions.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { getOrders } from '@/services/tpv/order.tpv.service'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { crearFixture, exigir, exigirBaseDesechable, type Fixture } from '../payments/webhookCheckpoint.fixture'

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
let seq = 0

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('t9folios')
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

const CIEN = 10_000
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

const pedido = (onlineOrderId: string) => exigir(prisma.onlineOrder.findUnique({ where: { id: onlineOrderId } }))
const vencer = async (orderId: string) =>
  expect(await expireOnlineOrder({ venueId: f.venueId, orderId })).toMatchObject({ outcome: 'OK', status: 'EXPIRED' })

/** La cola sin red del POS: efectivo YA cobrado que llega tarde (nunca se rechaza). */
async function colaSinRed(orderId: string, centavos = CIEN) {
  const [ack] = await processIntents({
    venueId: f.venueId,
    staffId: f.staffId,
    deviceId: `aparato-${f.fixture}`,
    intents: [{ id: randomUUID(), seq: ++seq, type: 'PAY_CASH', payload: { orderId, amountCents: centavos, tipCents: 0, method: 'CASH' } }],
    authorizeIntent: () => true,
  })
  expect(ack).toMatchObject({ status: 'ACKED' })
}

const idsTpv = async () => (await getOrders(f.venueId)).map(o => o.id)
const idsPos = async () => (await listOrders(f.venueId, { page: 1, pageSize: 100 })).data.map((o: { id: string }) => o.id)

describe('T11 · cuentas abiertas sin folios por pagar', () => {
  it('un folio por pagar no sale en la TPV ni en el POS; uno de «Mi equipo» por aceptar sigue saliendo', async () => {
    const folio = await nuevoFolio()
    const equipo = await nuevoFolio({ equipo: true })
    const tpv = await idsTpv()
    const pos = await idsPos()
    expect(tpv).not.toContain(folio.orderId)
    expect(pos).not.toContain(folio.orderId)
    expect(tpv).toContain(equipo.orderId)
    expect(pos).toContain(equipo.orderId)
  })

  it('un folio vencido con abono tardío sí sale: su cuenta reabierta se cobra en las cuentas abiertas', async () => {
    const x = await nuevoFolio({ vencido: true })
    await vencer(x.orderId)
    await colaSinRed(x.orderId, CINCUENTA)
    expect((await pedido(x.onlineOrderId)).status).not.toBe('PENDING_ACCEPTANCE')
    expect(await idsTpv()).toContain(x.orderId)
    expect(await idsPos()).toContain(x.orderId)
  })
})
